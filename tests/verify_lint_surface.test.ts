import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  auditBunfigLintRules,
  DOMAIN_TARGETS,
  EXIT_UNAVAILABLE,
  findDoctorUnsupportedLines,
  isRuleActive,
  parsePrintConfigJson,
  parseRuleCatalog,
  REQUIRED_ACTIVE_RULES,
} from "../scripts/verify_lint_surface.ts";

const ROOT = resolve(import.meta.dir, "..");

async function configuredRuleNames(): Promise<string[]> {
  const bunfig = Bun.TOML.parse(
    await Bun.file(resolve(ROOT, "bunfig.toml")).text(),
  ) as {
    lint?: {
      rules?: Record<string, unknown>;
      overrides?: Array<{ rules?: Record<string, unknown> }>;
    };
  };
  return [
    ...new Set([
      ...Object.keys(bunfig.lint?.rules ?? {}),
      ...(bunfig.lint?.overrides ?? []).flatMap((entry) =>
        Object.keys(entry.rules ?? {}),
      ),
    ]),
  ];
}

function makeFakeCanary(catalog: string): {
  readonly dir: string;
  readonly bin: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "fake-bun-canary-"));
  const bin = join(dir, "bun");
  const script = `#!/bin/sh
DIR="@D@(dirname "@D@0")"
case "@D@*" in
  *"lint --help"*) echo "Usage: bun lint";;
  *"--rules -f json"*) cat "@D@DIR/catalog.json";;
  *"--explain"*) echo "rule docs";;
  *"--print-config"*) cat "@D@DIR/print-config.json";;
  *"--doctor"*) echo "bun lint doctor: clean";;
  *) echo "ok";;
esac
exit 0
`.replaceAll("@D@", "$");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "catalog.json"), catalog);
  writeFileSync(
    join(dir, "print-config.json"),
    JSON.stringify({
      rules: Object.fromEntries(REQUIRED_ACTIVE_RULES.map((rule) => [rule, 2])),
    }),
  );
  return { dir, bin };
}

function runFakePreflight(catalog: string): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const fake = makeFakeCanary(catalog);
  try {
    const result = Bun.spawnSync(
      [process.execPath, "--no-env-file", "scripts/verify_lint_surface.ts"],
      {
        cwd: ROOT,
        env: { ...process.env, BUN_LINT_BIN: fake.bin },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
}

describe("verify_lint_surface preflight helpers", () => {
  test("all DOMAIN_TARGETS exist in sportsdesk-ops and all REQUIRED_ACTIVE_RULES are active in bunfig.toml", async () => {
    for (const target of DOMAIN_TARGETS) {
      expect(existsSync(resolve(ROOT, target)), target).toBe(true);
    }
    const bunfig = Bun.TOML.parse(
      await Bun.file(resolve(ROOT, "bunfig.toml")).text(),
    ) as { lint?: { rules?: Record<string, unknown> } };
    const rules = bunfig.lint?.rules ?? {};
    for (const rule of REQUIRED_ACTIVE_RULES) {
      expect(isRuleActive(rules[rule]), rule).toBe(true);
    }
  });

  test("parseRuleCatalog accepts metadata objects and strings and fails closed on malformed JSON", () => {
    expect(
      parseRuleCatalog('["eqeqeq", {"name":"no-console"}, {"rule":"eqeqeq"}]'),
    ).toEqual(["eqeqeq", "no-console", "eqeqeq"]);
    expect(parseRuleCatalog("not json")).toBeNull();
    expect(parseRuleCatalog("{}")).toBeNull();
    expect(parseRuleCatalog("[]")).toBeNull();
  });

  test("package and canary CI wire verify:lint-surface into the preflight job", async () => {
    const pkg = (await Bun.file(resolve(ROOT, "package.json")).json()) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["verify:lint-surface"]).toBe(
      "bun run scripts/verify_lint_surface.ts",
    );
    const ci = await Bun.file(resolve(ROOT, ".github/workflows/ci.yml")).text();
    expect(ci).toContain("run: bun run verify:lint-surface");
  });

  test("isRuleActive distinguishes active warn/error severities from off/0", () => {
    expect(isRuleActive(1)).toBe(true);
    expect(isRuleActive(2)).toBe(true);
    expect(isRuleActive("warn")).toBe(true);
    expect(isRuleActive("error")).toBe(true);
    expect(isRuleActive(["error", "smart"])).toBe(true);
    expect(isRuleActive(0)).toBe(false);
    expect(isRuleActive([0])).toBe(false);
    expect(isRuleActive("off")).toBe(false);
    expect(isRuleActive(["off"])).toBe(false);
    expect(isRuleActive(undefined)).toBe(false);
  });

  test("parsePrintConfigJson slices trailing note: lines cleanly (#47174)", () => {
    const raw =
      '{"rules":{"eqeqeq":[2,"smart"]}}\nnote: --print-config does not validate rule options\n';
    expect(parsePrintConfigJson(raw)).toEqual({
      rules: { eqeqeq: [2, "smart"] },
    });
    expect(parsePrintConfigJson("not json")).toBeNull();
  });

  test("auditBunfigLintRules checks both [lint.rules] and [[lint.overrides]] and flags no-restricted-imports shadowing", () => {
    const sample = `
[lint.rules]
"eqeqeq" = ["error", "smart"]
"no-restricted-imports" = ["error", { paths = ["fs"] }]

[[lint.overrides]]
files = ["packages/**"]
[lint.overrides.rules]
"no-restricted-imports" = ["error", { paths = ["bun:sqlite"] }]
"bogus/made-up-rule" = "error"
`;
    const valid = new Set(["eqeqeq", "no-restricted-imports"]);
    const audit = auditBunfigLintRules(sample, valid);
    expect(audit.unknownRules).toEqual(["bogus/made-up-rule"]);
    expect(audit.shadowsRestrictedImports).toBe(true);
  });

  test("findDoctorUnsupportedLines flags unsupported and JS-hosted rules (#49393)", () => {
    const output = [
      "bun lint doctor: ok",
      "warning: 2 unsupported rules skipped",
      "note: custom/foo is js-hosted and ignored",
    ].join("\n");
    expect(findDoctorUnsupportedLines(output)).toHaveLength(2);
    expect(findDoctorUnsupportedLines("bun lint doctor: clean")).toEqual([]);
  });

  test("four-stage preflight passes against a deterministic fake canary", async () => {
    const names = await configuredRuleNames();
    const result = runFakePreflight(
      JSON.stringify(names.map((name) => ({ name }))),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("=== Bun Lint Surface");
  });

  test("preflight returns EXIT_DATAERR (65) when bunfig references a rule missing from the catalog", async () => {
    const names = await configuredRuleNames();
    const missing = names[0]!;
    const result = runFakePreflight(
      JSON.stringify(
        names.filter((name) => name !== missing).map((name) => ({ name })),
      ),
    );
    expect(result.code).toBe(65);
    expect(result.stderr).toContain("ERR_LINT_UNKNOWN_RULE");
    expect(result.stderr).toContain(missing);
  });

  test("preflight returns EXIT_SOFTWARE (70) for malformed catalog output", () => {
    const result = runFakePreflight("not json");
    expect(result.code).toBe(70);
    expect(result.stderr).toContain("ERR_LINT_CATALOG_FAILED");
  });

  test("CLI fails closed with EXIT_UNAVAILABLE (69) when no native bun lint binary is present", () => {
    const res = Bun.spawnSync(
      [process.execPath, "--no-env-file", "scripts/verify_lint_surface.ts"],
      {
        cwd: ROOT,
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home-no-canary" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(res.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(res.stderr.toString("utf8")).toContain("ERR_OPS_BINARY_MISSING");
  });
});
