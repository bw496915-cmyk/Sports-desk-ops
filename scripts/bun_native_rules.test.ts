import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ALL_RULES,
  classifyBunLink,
  classifyJsonArtifact,
  credentialPatternHits,
  EXPECTED_LOCKFILE_VERSION,
  GateRuleError,
  isPreBase64AzurePat,
  nativeBunLintAvailable,
  PINNED_BUN_SHA,
  repoViewFromDirectory,
  runRules,
  type GateCode,
  type GateFinding,
} from "./bun_native_rules.ts";

const PINNED_LEAF = `https://github.com/oven-sh/bun/blob/${PINNED_BUN_SHA}/docs/runtime/s3.mdx`;
const BUN_1_4_4 = { bunVersion: "1.4.4" };
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const GOOD_FILES: Record<string, string> = {
  "bun.lock": `{\n  "lockfileVersion": ${EXPECTED_LOCKFILE_VERSION},\n  "configVersion": 1,\n  "workspaces": {},\n}\n`,
  "bunfig.toml": [
    "[install]",
    "exact = true",
    "ignoreScripts = true",
    "",
    '[install.scopes."@sportsdesk"]',
    'url = "https://registry.npmjs.org/"',
    'token = "$NPM_READ_TOKEN"',
    "",
  ].join("\n"),
  ".gitattributes":
    "bun.lock text eol=lf linguist-generated=true\n*.lockb binary diff=lockb linguist-generated=true\n",
  "package.json": JSON.stringify({
    name: "root",
    private: true,
    workspaces: ["packages/*"],
    trustedDependencies: [],
  }),
  "packages/sportsdesk-ops/package.json": JSON.stringify({
    name: "@sportsdesk/ops",
    exports: {
      "./tokens": "./src/generated/domain-branded-types.ts",
      "./tokens/css": "./src/generated/tokens.css",
    },
    scripts: { lint: "oxlint --deny-warnings src" },
    devDependencies: { "@types/bun": "1.4.4" },
  }),
  "packages/sportsdesk-ops/src/generated/domain-branded-types.ts":
    "export {};\n",
  "packages/sportsdesk-ops/src/generated/tokens.css": ":root {}\n",
  "packages/nsh-desk/package.json": JSON.stringify({
    name: "@sportsdesk/nsh-desk",
    dependencies: { "@sportsdesk/ops": "workspace:*" },
    devDependencies: { "@types/bun": "1.4.4" },
  }),
  "src/ok.ts":
    "for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) console.log(rowIndex);\n",
  "lib/magic.ts": "export const FROZEN_DODBIN_MAGIC_LE32 = 0x444F4436;\n",
  "docs/links.md": `[s3](${PINNED_LEAF}) and [release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4)\n`,
  "config/settings.json": "{}\n",
  "tests/fixtures/sample.json": "{}\n",
  ".env.example": "CLOUDFLARE_API_TOKEN=\nCLOUDFLARE_R2_API_TOKEN=\n",
};

async function fixture(
  overrides: Record<string, string | null> = {},
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "bun-native-rules-"));
  created.push(root);
  const files = { ...GOOD_FILES, ...overrides };
  for (const [relative, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    await Bun.write(join(root, relative), content);
  }
  return root;
}

async function errorsFor(
  overrides: Record<string, string | null> = {},
  context = BUN_1_4_4,
): Promise<GateFinding[]> {
  const findings = await runRules(
    repoViewFromDirectory(await fixture(overrides)),
    context,
  );
  return findings.filter((finding) => finding.severity === "error");
}

function codes(findings: readonly GateFinding[]): GateCode[] {
  return [...new Set(findings.map((finding) => finding.code))].sort();
}

const fakeSecret = (length: number): string =>
  Array.from({ length }, (_, offset) => "Zq7"[offset % 3]).join("");

describe("good fixture", () => {
  test("passes every rule", async () => {
    expect(await errorsFor()).toEqual([]);
    expect(ALL_RULES.length).toBe(12);
  });
});

describe("lockfile rule", () => {
  test("requires a root text bun.lock that Bun.JSONC.parse reads", async () => {
    expect(codes(await errorsFor({ "bun.lock": null }))).toEqual([
      "ERR_LOCKFILE_MISSING",
    ]);
    expect(
      codes(
        await errorsFor({
          "bun.lock": '{ "lockfileVersion": 1, "configVersion": 1 }',
        }),
      ),
    ).toEqual(["ERR_LOCKFILE_VERSION"]);
    expect(
      codes(
        await errorsFor({
          "bun.lock": `{ "lockfileVersion": ${EXPECTED_LOCKFILE_VERSION}, "configVersion": 0 }`,
        }),
      ),
    ).toEqual(["ERR_LINKER_NOT_ISOLATED"]);
    const broken = await fixture({ "bun.lock": "{ not json" });
    expect(
      runRules(repoViewFromDirectory(broken), BUN_1_4_4),
    ).rejects.toBeInstanceOf(GateRuleError);
  });

  test("forbids foreign and nested lockfiles and .npmrc", async () => {
    const findings = await errorsFor({
      "bun.lockb": "binary",
      "yarn.lock": "",
      "package-lock.json": "{}",
      "pnpm-lock.yaml": "",
      "packages/sportsdesk-ops/bun.lock": "{}",
      "packages/nsh-desk/.npmrc": "registry=https://registry.npmjs.org/\n",
    });
    expect(codes(findings)).toEqual([
      "ERR_FOREIGN_LOCKFILE",
      "ERR_NESTED_BUN_LOCK",
      "ERR_NPMRC_FORBIDDEN",
    ]);
    expect(
      findings.filter((finding) => finding.code === "ERR_FOREIGN_LOCKFILE")
        .length,
    ).toBe(4);
  });

  test("the root .npmrc waiver is reported, and flagged stale once the file is gone", async () => {
    const withNpmrc = await runRules(
      repoViewFromDirectory(
        await fixture({ ".npmrc": "@x:registry=https://r.example/\n" }),
      ),
      BUN_1_4_4,
    );
    expect(
      withNpmrc.find((finding) => finding.file === ".npmrc")?.severity,
    ).toBe("waived");
    const without = await runRules(
      repoViewFromDirectory(await fixture()),
      BUN_1_4_4,
    );
    expect(
      without.some(
        (finding) =>
          finding.rule === "waivers" && finding.severity === "notice",
      ),
    ).toBe(true);
  });
});

describe("credential and env rules report names, never values", () => {
  test("URL-embedded credentials in registry surfaces", async () => {
    const secret = fakeSecret(24);
    const findings = await errorsFor({
      "packages/nsh-desk/package.json": JSON.stringify({
        name: "@sportsdesk/nsh-desk",
        dependencies: { "@sportsdesk/ops": "workspace:*" },
        devDependencies: { "@types/bun": "1.4.4" },
        repository: {
          url: `https://deploy:${secret}@git.example.com/repo.git`,
        },
      }),
      ".github/workflows/ci.yml": `run: echo //registry.example.com/:_authToken=${secret}\n`,
      "config/.env.ci": `NPM_CONFIG=//registry.example.com/:_password=${secret}\nX=//r.example/:username=bot\nY=//r.example/:_auth=${secret}\n`,
    });
    expect(codes(findings)).toEqual(["ERR_URL_EMBEDDED_CREDENTIAL"]);
    const labels = findings.map((finding) => finding.detail).join("\n");
    for (const label of [
      "user:pass@",
      "/_authToken=",
      ":_password=",
      ":username=",
      "/_auth=",
    ])
      expect(labels).toContain(label);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  test("templated secrets are not credentials", async () => {
    const templated = [
      'run: printf "//registry.npmjs.org/:_authToken=%s\\n" "$NPM_TOKEN"',
      "run: echo //registry.npmjs.org/:_authToken=${{ secrets.NPM_TOKEN }}",
      "run: echo https://ci:${CI_TOKEN}@git.example.com",
      "run: echo //r.example/:_password=$NPM_PASSWORD",
    ].join("\n");
    expect(credentialPatternHits("//r.example/:_authToken=<token>")).toEqual(
      [],
    );
    expect(
      await errorsFor({ ".github/workflows/publish.yml": `${templated}\n` }),
    ).toEqual([]);
  });

  test("ERR_NPM_DOUBLE_BASE64_PAT on a 112-char base64 Azure PAT only", async () => {
    const rawPat = fakeSecret(84);
    const doubleEncoded = btoa(rawPat);
    expect(doubleEncoded.length).toBe(112);
    expect(isPreBase64AzurePat(doubleEncoded)).toBe(true);
    expect(isPreBase64AzurePat(rawPat)).toBe(false);
    const findings = await errorsFor({
      "registry.env": `NPM_PASSWORD="${doubleEncoded}"\n`,
    });
    expect(codes(findings)).toEqual(["ERR_NPM_DOUBLE_BASE64_PAT"]);
    expect(JSON.stringify(findings)).not.toContain(doubleEncoded);
    expect(
      await errorsFor({ "registry.env": `NPM_PASSWORD=${rawPat}\n` }),
    ).toEqual([]);
  });

  test("ERR_CF_TOKEN_BLEED_10000 when one .env* sets both Cloudflare tokens", async () => {
    const r2Token = fakeSecret(40);
    const apiToken = fakeSecret(41);
    const bleed = await errorsFor({
      ".env.local": `CLOUDFLARE_R2_API_TOKEN=${r2Token}\nexport CLOUDFLARE_API_TOKEN='${apiToken}'\n`,
    });
    expect(codes(bleed)).toEqual(["ERR_CF_TOKEN_BLEED_10000"]);
    expect(bleed[0]?.detail).toContain("CLOUDFLARE_R2_API_TOKEN");
    expect(JSON.stringify(bleed)).not.toContain(r2Token);
    expect(JSON.stringify(bleed)).not.toContain(apiToken);
    expect(
      await errorsFor({
        "r2.env": `CLOUDFLARE_R2_API_TOKEN=${r2Token}\n`,
        "pages.env": `CLOUDFLARE_API_TOKEN=${apiToken}\n`,
      }),
    ).toEqual([]);
    const crossed = await errorsFor({
      "r2.env": `CLOUDFLARE_API_TOKEN=${apiToken}\n`,
    });
    expect(codes(crossed)).toEqual(["ERR_CF_TOKEN_BLEED_10000"]);
  });
});

describe(".gitattributes rule", () => {
  test("bun.lock text line strictly before *.lockb binary line, binary before diff=lockb", async () => {
    const swapped =
      "*.lockb binary diff=lockb linguist-generated=true\nbun.lock text eol=lf linguist-generated=true\n";
    expect(codes(await errorsFor({ ".gitattributes": swapped }))).toEqual([
      "ERR_GITATTRIBUTES_ORDER",
    ]);
    expect(codes(await errorsFor({ ".gitattributes": null }))).toEqual([
      "ERR_GITATTRIBUTES_ORDER",
    ]);
    const diffFirst =
      "bun.lock text eol=lf linguist-generated=true\n*.lockb diff=lockb binary linguist-generated=true\n";
    expect(codes(await errorsFor({ ".gitattributes": diffFirst }))).toEqual([
      "ERR_GITATTRIBUTES_ORDER",
    ]);
  });
});

describe("global install rule", () => {
  test("flags global bun installs in docs and scripts", async () => {
    const command = ["bun", "i", "-g", "some-cli"].join(" ");
    const findings = await errorsFor({
      "docs/setup.md": `Run \`${command}\`\n`,
      "scripts/setup.sh": ["bun", "add", "--global", "x"].join(" "),
    });
    expect(codes(findings)).toEqual(["ERR_BUN_GLOBAL_INSTALL"]);
    expect(findings.length).toBe(2);
    expect(
      await errorsFor({ "docs/setup.md": "bun install --frozen-lockfile\n" }),
    ).toEqual([]);
  });
});

describe("bunfig rule", () => {
  const base = GOOD_FILES["bunfig.toml"] ?? "";
  test("strict TOML 1.0 inline tables", async () => {
    const multiLine = `${base}\n[install.cache]\nx = {\n  dir = "a"\n}\n`;
    expect(codes(await errorsFor({ "bunfig.toml": multiLine }))).toContain(
      "ERR_BUNFIG_MULTILINE_INLINE_TABLE",
    );
    const singleLine = base.replace(
      /\[install\.scopes[\s\S]*$/,
      '[install.scopes]\n"@sportsdesk" = { url = "https://registry.npmjs.org/", token = "$NPM_READ_TOKEN" }\n',
    );
    expect(await errorsFor({ "bunfig.toml": singleLine })).toEqual([]);
  });

  test("install floor, yarn lockfile print, literal credentials, non-isolated linker", async () => {
    expect(
      codes(
        await errorsFor({
          "bunfig.toml": base.replace("exact = true", "exact = false"),
        }),
      ),
    ).toEqual(["ERR_BUNFIG_INSTALL_FLOOR"]);
    expect(
      codes(
        await errorsFor({
          "bunfig.toml": base.replace("ignoreScripts = true\n", ""),
        }),
      ),
    ).toEqual(["ERR_BUNFIG_INSTALL_FLOOR"]);
    expect(
      codes(
        await errorsFor({
          "bunfig.toml": `${base}\n[install.lockfile]\nprint = "yarn"\n`,
        }),
      ),
    ).toEqual(["ERR_BUNFIG_YARN_LOCKFILE"]);
    const secret = fakeSecret(30);
    const literal = await errorsFor({
      "bunfig.toml": base.replace('"$NPM_READ_TOKEN"', `"${secret}"`),
    });
    expect(codes(literal)).toEqual(["ERR_BUNFIG_LITERAL_CREDENTIAL"]);
    expect(JSON.stringify(literal)).not.toContain(secret);
    expect(
      codes(
        await errorsFor({
          "bunfig.toml": base.replace(
            "[install]\n",
            '[install]\nlinker = "hoisted"\n',
          ),
        }),
      ),
    ).toEqual(["ERR_LINKER_NOT_ISOLATED"]);
  });
});

describe("manifest rules", () => {
  test("root package.json: private, workspaces, trustedDependencies [], no new root deps", async () => {
    const root = {
      name: "root",
      private: false,
      workspaces: ["apps/*"],
      dependencies: { "left-pad": "1.3.0" },
    };
    const findings = await errorsFor({ "package.json": JSON.stringify(root) });
    expect(codes(findings)).toEqual(["ERR_ROOT_MANIFEST"]);
    expect(findings.length).toBe(4);
  });

  test("leaf names, exact @types/bun, no leaf trustedDependencies, exports, workspace link", async () => {
    const findings = await errorsFor({
      "packages/extra/package.json": JSON.stringify({
        name: "@sportsdesk/ops",
        devDependencies: { "@types/bun": "^1.4.4" },
        trustedDependencies: [],
      }),
      "packages/legacy/package.json": JSON.stringify({
        name: "unscoped",
        devDependencies: { "@types/bun": "1.4.4" },
      }),
      "packages/nsh-desk/package.json": JSON.stringify({
        name: "@sportsdesk/nsh-desk",
        devDependencies: { "@types/bun": "1.4.4" },
      }),
      "packages/sportsdesk-ops/src/generated/tokens.css": null,
    });
    const details = findings
      .map((finding) => `${finding.file} ${finding.detail}`)
      .join("\n");
    expect(codes(findings)).toEqual(["ERR_LEAF_MANIFEST"]);
    expect(details).toContain("duplicates");
    expect(details).toContain('must be exactly "1.4.4"');
    expect(details).toContain("trustedDependencies is forbidden");
    expect(details).toContain('"unscoped" must be @sportsdesk/*');
    expect(details).toContain('"@sportsdesk/ops"] must be "workspace:*"');
    expect(details).toContain("does not exist");
  });

  test("ERR_LINT_SCRIPT_RECURSION: bun lint is a package-script lookup before Bun 1.5", async () => {
    expect(nativeBunLintAvailable("1.4.4")).toBe(false);
    expect(nativeBunLintAvailable("1.5.0")).toBe(true);
    const manifest = (lint: string): string =>
      JSON.stringify({
        name: "@sportsdesk/ops",
        exports: {
          "./tokens": "./src/generated/domain-branded-types.ts",
          "./tokens/css": "./src/generated/tokens.css",
        },
        scripts: { lint },
        devDependencies: { "@types/bun": "1.4.4" },
      });
    const recursive = {
      "packages/sportsdesk-ops/package.json": manifest(
        "bun lint --no-script --deny-warnings",
      ),
    };
    expect(codes(await errorsFor(recursive))).toEqual([
      "ERR_LINT_SCRIPT_RECURSION",
    ]);
    expect(await errorsFor(recursive, { bunVersion: "1.5.0" })).toEqual([]);
    const missingFlag = {
      "packages/sportsdesk-ops/package.json": manifest(
        "bun lint --deny-warnings",
      ),
    };
    expect(
      codes(await errorsFor(missingFlag, { bunVersion: "1.5.0" })),
    ).toEqual(["ERR_LINT_SCRIPT_RECURSION"]);
  });
});

describe("naming and artifact rules", () => {
  test("DodSpine naming: legacy names are refused outside the frozen magic constant", async () => {
    const findings = await errorsFor({
      "src/new_reader.ts":
        'export const label = "DOD6";\n// see v5.4\nconst raw = 0x444f4436;\n',
    });
    expect(codes(findings)).toEqual(["ERR_DODSPINE_NAMING_LEAK"]);
    expect(findings[0]?.detail).toContain("3 DOD6/v5.4/magic-literal");
    expect(
      codes(await errorsFor({ "src/dod6_reader.ts": "export {};\n" })),
    ).toEqual(["ERR_DODSPINE_NAMING_LEAK"]);
  });

  test("loop indices must be descriptive", async () => {
    const findings = await errorsFor({
      "src/bad.ts": "for (let i = 0; i < 2; i++) {}\nfor (const k of []) {}\n",
    });
    expect(codes(findings)).toEqual(["ERR_LOOP_INDEX_NOT_DESCRIPTIVE"]);
    expect(findings[0]?.detail).toContain("2 single-letter");
  });

  test("oven-sh/bun source links are leaf blob URLs at the pinned SHA", async () => {
    expect(classifyBunLink(PINNED_LEAF)).toBe("pinned");
    expect(classifyBunLink(`${PINNED_LEAF}#L10-L20`)).toBe("pinned");
    expect(
      classifyBunLink(
        `https://github.com/oven-sh/bun/tree/${PINNED_BUN_SHA}/docs`,
      ),
    ).toBe("unpinned");
    expect(
      classifyBunLink(
        `https://github.com/oven-sh/bun/blob/${PINNED_BUN_SHA}/docs/`,
      ),
    ).toBe("unpinned");
    expect(
      classifyBunLink(
        "https://github.com/oven-sh/bun/blob/main/src/install/x.txt",
      ),
    ).toBe("unpinned");
    expect(
      classifyBunLink(
        "https://github.com/oven-sh/bun/blob/b6e7b9cdc4e7e1720b65f2e43a62debb3ab61283/docs/a.mdx",
      ),
    ).toBe("unpinned");
    expect(
      classifyBunLink("https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4"),
    ).toBe("exempt");
    expect(classifyBunLink("https://github.com/oven-sh/bun/issues/1")).toBe(
      "exempt",
    );
    expect(classifyBunLink("https://github.com/oven-sh/bun")).toBe("exempt");
    const findings = await errorsFor({
      "docs/bad.md": `[docs](https://github.com/oven-sh/bun/tree/${PINNED_BUN_SHA}/docs)\n`,
    });
    expect(codes(findings)).toEqual(["ERR_BUN_SOURCE_URL_NOT_PINNED"]);
    expect(findings[0]?.line).toBe(1);
  });

  test("ERR_OPS_LOCAL_JSON_FORBIDDEN: data JSON and SQLite outside config and contract trees", async () => {
    expect(classifyJsonArtifact("package.json")).toBe("allowed");
    expect(classifyJsonArtifact("packages/ui/tsconfig.build.json")).toBe(
      "allowed",
    );
    expect(classifyJsonArtifact("tests/fixtures/x.json")).toBe("allowed");
    expect(classifyJsonArtifact("docs/evidence/captures/a.json")).toBe(
      "allowed",
    );
    expect(classifyJsonArtifact("data/new-dump.json")).toBe("artifact");
    expect(classifyJsonArtifact("reports/run.sqlite")).toBe("forbidden-data");
    expect(classifyJsonArtifact("cache.db-wal")).toBe("forbidden-data");
    const findings = await errorsFor({
      "data/new-dump.json": "[]",
      "local.sqlite": "x",
      "scratchpad/out.json": "{}",
    });
    expect(codes(findings)).toEqual(["ERR_OPS_LOCAL_JSON_FORBIDDEN"]);
    expect(findings.length).toBe(3);
  });
});

describe("verify_ci_gates CLI", () => {
  const cli = resolve(import.meta.dir, "verify_ci_gates.ts");
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, cli, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

  test("exit 0 on a clean tree, 1 on violations, 2 on bad usage", async () => {
    const clean = run("--root", await fixture());
    expect(clean.stdout.toString()).toContain("verify_ci_gates: PASS");
    expect(clean.exitCode).toBe(0);
    const dirty = await fixture({ "yarn.lock": "" });
    const failed = run("--root", dirty, "--json");
    expect(failed.exitCode).toBe(1);
    const report = JSON.parse(failed.stdout.toString()) as {
      findings: GateFinding[];
    };
    expect(
      report.findings.some(
        (finding) => finding.code === "ERR_FOREIGN_LOCKFILE",
      ),
    ).toBe(true);
    unlinkSync(join(dirty, "yarn.lock"));
    expect(run("--root", dirty).exitCode).toBe(0);
    expect(run("--bogus").exitCode).toBe(2);
  });
});
