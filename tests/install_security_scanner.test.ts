import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import bunfig from "../bunfig.toml" with { type: "toml" };

import {
  advisoryFor,
  canonicalPackageName,
  checkExtendedOfflinePolicy,
  createScanner,
  defaultRegistryFromProjectFiles,
  EXTENDED_DENYLIST,
  openScannerCache,
  packagesFromLockfile,
  packagesFromManifest,
  parseCvssV3BaseScore,
  rangeSelectsOnlyCompromise,
  registryCore,
  scanner,
  scoreToSeverity,
  tarballCore,
} from "../scripts/install_security_scanner.ts";

const probeRoot = path.join(import.meta.dir, ".tmp-scanner-probe");
const lockRoot = path.join(import.meta.dir, ".tmp-scanner-lock");
const workspaceRoot = path.join(import.meta.dir, ".tmp-scanner-workspace");
const osvRoot = path.join(import.meta.dir, ".tmp-scanner-osv");
afterAll(() => {
  rmSync(probeRoot, { recursive: true, force: true });
  rmSync(lockRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(osvRoot, { recursive: true, force: true });
});

function pkg(
  name: string,
  version: string,
  fields: { requestedRange?: string; tarball?: string } = {},
): Bun.Security.Package {
  return {
    name,
    version,
    requestedRange: fields.requestedRange ?? version,
    tarball: fields.tarball ?? "",
  };
}

describe("install security scanner", () => {
  test("satisfies flags the compromise range and ignores a prerelease", () => {
    for (const version of ["3.3.6", "3.3.6+build", "3.9.0", "v3.3.6"]) {
      const advisory = advisoryFor(pkg("event-stream", version));
      expect(advisory?.level).toBe("fatal");
      expect(Bun.semver.satisfies(version, ">=3.3.6 <4.0.0")).toBe(true);
    }
    expect(Bun.semver.order("3.3.6+build", "3.3.6")).toBe(0);
    expect(advisoryFor(pkg("event-stream", "3.3.6-compromised.1"))).toBeNull();
    expect(advisoryFor(pkg("event-stream", "3.3.5"))).toBeNull();
    expect(advisoryFor(pkg("event-stream", "4.0.0"))).toBeNull();
    expect(advisoryFor(pkg("event-stream", "4.0.1"))).toBeNull();
    expect(registryCore("3.3.6-compromised.1")).toBe("3.3.6");
  });

  test("a non-registry version does not satisfy the compromise range", () => {
    for (const version of [
      "file:vendor/event-stream",
      "github:dominictarr/event-stream#f82b1c",
      "git+https://github.com/dominictarr/event-stream.git",
      "https://registry.npmjs.org/event-stream/-/event-stream-3.3.6.tgz",
      "V3.3.6",
    ]) {
      expect(Bun.semver.satisfies(version, ">=3.3.6 <4.0.0")).toBe(false);
      expect(advisoryFor(pkg("event-stream", version))).toBeNull();
    }
  });

  test("flatmap-stream is fatal at every version", () => {
    expect(advisoryFor(pkg("flatmap-stream", "0.1.1"))?.level).toBe("fatal");
    expect(advisoryFor(pkg("flatmap-stream", "0.1.0"))?.level).toBe("fatal");
    expect(
      advisoryFor(pkg("flatmap-stream", "file:vendor/flatmap-stream"))?.level,
    ).toBe("fatal");
  });

  test("a safe registry version still fails when the tarball or request does", () => {
    const matching = pkg("event-stream", "4.0.1", {
      requestedRange: "^4.0.0",
      tarball:
        "https://registry.npmjs.org/event-stream/-/event-stream-4.0.1.tgz?cache=1",
    });
    expect(advisoryFor(matching)).toBeNull();
    expect(tarballCore(matching.tarball)).toBe("4.0.1");

    const compromisedTarball = pkg("event-stream", "4.0.1", {
      requestedRange: "^4.0.0",
      tarball:
        "https://registry.npmjs.org/event-stream/-/event-stream-3.3.6.tgz",
    });
    expect(advisoryFor(compromisedTarball)?.level).toBe("fatal");

    const mismatchedTarball = pkg("event-stream", "4.0.1", {
      requestedRange: "*",
      tarball:
        "https://registry.npmjs.org/event-stream/-/event-stream-4.0.0.tgz",
    });
    expect(advisoryFor(mismatchedTarball)?.description).toContain(
      "does not match resolved 4.0.1",
    );

    const localTarball = pkg("event-stream", "4.0.1", {
      requestedRange: "4.0.1",
      tarball: "./vendor/event-stream-4.0.1.tgz",
    });
    expect(advisoryFor(localTarball)?.description).toContain(
      "not a public npm tarball",
    );

    const foreignHost = pkg("event-stream", "4.0.1", {
      requestedRange: "^4.0.0",
      tarball: "https://evil.example/event-stream/-/event-stream-4.0.1.tgz",
    });
    expect(advisoryFor(foreignHost)?.description).toContain(
      "not a public npm tarball",
    );
    expect(
      advisoryFor(
        pkg("event-stream", "4.0.1", {
          requestedRange: "^4.0.0",
          tarball:
            "https://registry.yarnpkg.com/event-stream/-/event-stream-4.0.1.tgz",
        }),
      ),
    ).toBeNull();

    const unnamedTarball = pkg("event-stream", "4.0.1", {
      requestedRange: "4.0.1",
      tarball:
        "https://api.github.com/repos/dominictarr/event-stream/tarball/f82b1c",
    });
    expect(advisoryFor(unnamedTarball)?.description).toContain(
      "not a public npm tarball",
    );

    expect(
      advisoryFor(pkg("event-stream", "4.0.1", { requestedRange: "3.3.6" }))
        ?.level,
    ).toBe("fatal");
    expect(
      advisoryFor(
        pkg("event-stream", "4.0.1", {
          requestedRange: ">=3.3.6 <4.0.0",
        }),
      )?.description,
    ).toContain("selects only");
    expect(
      advisoryFor(pkg("event-stream", "4.0.1", { requestedRange: "~3.3.6" }))
        ?.level,
    ).toBe("fatal");
    expect(
      advisoryFor(
        pkg("event-stream", "4.0.1", {
          requestedRange: "file:vendor/event-stream",
        }),
      ),
    ).toBeNull();

    expect(
      advisoryFor(pkg("event-stream", "4.0.1", { requestedRange: "*" })),
    ).toBeNull();
    expect(
      advisoryFor(pkg("event-stream", "4.0.1", { requestedRange: "latest" })),
    ).toBeNull();
    expect(
      advisoryFor(pkg("event-stream", "4.0.1", { requestedRange: ">=3.3.6" })),
    ).toBeNull();
    expect(
      advisoryFor(pkg("event-stream", "4.0.1", { requestedRange: "^3.3.5" })),
    ).toBeNull();
    expect(rangeSelectsOnlyCompromise(">=3.3.6 <4.0.0")).toBe(true);
    expect(rangeSelectsOnlyCompromise("*")).toBe(false);
    expect(rangeSelectsOnlyCompromise("latest")).toBe(false);
    expect(rangeSelectsOnlyCompromise(">=3.3.7 <3.3.8")).toBe(true);
    expect(rangeSelectsOnlyCompromise(">=3.9.1 <3.9.2")).toBe(true);
    expect(
      advisoryFor(
        pkg("event-stream", "4.0.1", { requestedRange: ">=3.3.7 <3.3.8" }),
      )?.level,
    ).toBe("fatal");
    expect(advisoryFor(pkg("Flatmap-Stream", "0.1.1"))?.level).toBe("fatal");
    expect(advisoryFor(pkg("event-stream\u200b", "3.3.6"))?.level).toBe(
      "fatal",
    );

    const outside = ["0.0.0", "3.0.0", "3.3.0", "3.3.5", "4.0.0", "4.0.1"];
    const inside = [
      "3.3.6",
      "3.3.7",
      "3.3.8",
      "3.4.0",
      "3.9.0",
      "3.10.0",
      "3.11.0",
    ];
    for (const range of [
      ">=3.3.7 <3.3.8",
      "3.3.6 - 3.9.0",
      "3.3.6 - 4.0.1",
      "^3.3.6",
      "^3.3",
      "^3.3.5",
      "~3.3.6",
      ">=3.3.6",
      ">=3.3.6 <4.0.0",
      "*",
      "latest",
      "v3.3.6",
      "3.9.x",
      "3.11.0",
      "<=3.3.6",
      ">3.3",
      ">=3.3.7 <3.4.0 || >=4.0.0",
      ">=3.3.7 <3.3.8 || >=3.9.0 <3.9.2",
      ">3.3.6-0 <3.3.7",
      ">=3.3.6-0",
    ]) {
      const admitsInside = inside.some((version) =>
        Bun.semver.satisfies(version, range),
      );
      const admitsOutside = outside.some((version) =>
        Bun.semver.satisfies(version, range),
      );
      expect(rangeSelectsOnlyCompromise(range)).toBe(
        admitsInside && !admitsOutside,
      );
    }
  });

  test("an unrelated package is allowed", async () => {
    expect(advisoryFor(pkg("is-number", "7.0.0"))).toBeNull();
    expect(
      await scanner.scan({
        packages: [pkg("zod", "4.6.7"), pkg("event-stream", "4.0.1")],
      }),
    ).toEqual([]);
  });

  test("the project lockfile has no incident packages", async () => {
    const packages = packagesFromLockfile(await Bun.file("bun.lock").text());
    const cordis = packages.find((item) => item.name === "@deepseek-ai/cordis");
    expect(packages.length).toBeGreaterThan(0);
    expect(cordis?.version).toBe("4.1.0");
    expect(cordis?.tarball).toBe("");
    expect(await scanner.scan({ packages })).toEqual([]);
  });

  test("a lockfile tarball URL and a parent range are scanned", async () => {
    const swapped = packagesFromLockfile(
      JSON.stringify({
        packages: {
          "event-stream": [
            "event-stream@4.0.1",
            "https://registry.npmjs.org/event-stream/-/event-stream-3.3.6.tgz",
            {},
            "sha512-swapped",
          ],
        },
      }),
    );
    expect(swapped[0]?.tarball).toContain("event-stream-3.3.6.tgz");
    expect((await scanner.scan({ packages: swapped }))[0]?.level).toBe("fatal");

    const requested = packagesFromLockfile(
      JSON.stringify({
        workspaces: {
          "": { dependencies: { "event-stream": "~3.3.6" } },
        },
        packages: {
          "event-stream": ["event-stream@4.0.1", "", {}, "sha512-clean"],
        },
      }),
    );
    expect(requested[0]?.requestedRange).toBe("~3.3.6");
    expect((await scanner.scan({ packages: requested }))[0]?.level).toBe(
      "fatal",
    );

    const aliased = packagesFromLockfile(
      JSON.stringify({
        packages: {
          "safe-stream": [
            "safe-stream@npm:flatmap-stream@0.1.1",
            "",
            {},
            "sha512-alias",
          ],
        },
      }),
    );
    expect(aliased[0]?.name).toBe("flatmap-stream");
    expect((await scanner.scan({ packages: aliased }))[0]?.package).toBe(
      "flatmap-stream",
    );

    const hiddenPayload = packagesFromLockfile(
      JSON.stringify({
        packages: {
          "event-stream": [
            "event-stream@4.0.1",
            "",
            { dependencies: { "flatmap-stream": "0.1.1" } },
            "sha512-clean",
          ],
        },
      }),
    );
    expect(hiddenPayload.some((item) => item.name === "flatmap-stream")).toBe(
      true,
    );
    expect((await scanner.scan({ packages: hiddenPayload }))[0]?.level).toBe(
      "fatal",
    );

    const missingEntry = packagesFromLockfile(
      JSON.stringify({
        workspaces: {
          "": { dependencies: { "Flatmap-Stream": "0.1.1" } },
        },
        packages: {},
      }),
    );
    expect(missingEntry[0]?.name).toBe("flatmap-stream");
    expect((await scanner.scan({ packages: missingEntry }))[0]?.level).toBe(
      "fatal",
    );

    const patched = packagesFromLockfile(
      JSON.stringify({
        patchedDependencies: {
          "event-stream@4.0.1": "patches/event-stream@4.0.1.patch",
        },
        packages: {
          "event-stream": ["event-stream@4.0.1", "", {}, "sha512-clean"],
        },
      }),
    );
    expect(patched[0]?.requestedRange).toContain("patch:");
    expect((await scanner.scan({ packages: patched }))[0]?.level).toBe("fatal");

    const catalogued = packagesFromLockfile(
      JSON.stringify({
        catalog: { "event-stream": ">=3.3.7 <3.3.8" },
        packages: {
          "event-stream": ["event-stream@4.0.1", "", {}, "sha512-clean"],
        },
      }),
    );
    expect(catalogued[0]?.requestedRange).toBe(">=3.3.7 <3.3.8");
    expect((await scanner.scan({ packages: catalogued }))[0]?.level).toBe(
      "fatal",
    );

    const overridden = packagesFromLockfile(
      JSON.stringify({
        overrides: { "left-pad": "npm:flatmap-stream@0.1.1" },
        packages: {},
      }),
    );
    expect(overridden[0]?.name).toBe("flatmap-stream");
    expect((await scanner.scan({ packages: overridden }))[0]?.level).toBe(
      "fatal",
    );

    const privateRegistry = packagesFromLockfile(
      JSON.stringify({
        packages: {
          "event-stream": [
            "event-stream@4.0.1",
            "https://evil.example/npm/",
            {},
            "sha512-registry",
          ],
        },
      }),
    );
    expect(privateRegistry[0]?.tarball).toBe(
      "https://evil.example/npm/event-stream/-/event-stream-4.0.1.tgz",
    );
    expect(advisoryFor(privateRegistry[0]!)?.description).toContain(
      "not a public npm tarball",
    );

    const publicRegistry = packagesFromLockfile(
      JSON.stringify({
        packages: {
          "event-stream": [
            "event-stream@4.0.1",
            "https://registry.npmjs.org/",
            {},
            "sha512-public",
          ],
        },
      }),
    );
    expect(advisoryFor(publicRegistry[0]!)).toBeNull();

    const manifest = packagesFromManifest(
      JSON.stringify({
        dependencies: { "event-stream": ">=3.3.7 <3.3.8" },
      }),
    );
    expect(manifest[0]?.name).toBe("event-stream");
    expect(advisoryFor(manifest[0]!)?.level).toBe("fatal");

    const scoped = "@tennis-hq:registry=http://127.0.0.1:50851/\n";
    expect(defaultRegistryFromProjectFiles(null, scoped)).toBe("");
    expect(
      defaultRegistryFromProjectFiles(
        '[install]\nregistry = "https://evil.example/npm"\n',
        scoped,
      ),
    ).toBe("https://evil.example/npm");

    const lockedSafe = JSON.stringify({
      packages: {
        "event-stream": ["event-stream@4.0.1", "", {}, "sha512-default"],
      },
    });
    const mirrored = packagesFromLockfile(
      lockedSafe,
      "https://evil.example/npm",
    );
    expect(mirrored[0]?.tarball).toBe(
      "https://evil.example/npm/event-stream/-/event-stream-4.0.1.tgz",
    );
    expect(advisoryFor(mirrored[0]!)?.level).toBe("fatal");
    expect(
      advisoryFor(
        packagesFromLockfile(lockedSafe, "https://registry.npmjs.org")[0]!,
      ),
    ).toBeNull();
    expect(advisoryFor(packagesFromLockfile(lockedSafe)[0]!)).toBeNull();
  });

  test("scan reads a patched event-stream from the working directory", () => {
    rmSync(lockRoot, { recursive: true, force: true });
    mkdirSync(lockRoot);
    writeFileSync(
      path.join(lockRoot, "bun.lock"),
      JSON.stringify({
        patchedDependencies: {
          "event-stream@4.0.1": "patches/event-stream@4.0.1.patch",
        },
        packages: {
          "event-stream": ["event-stream@4.0.1", "", {}, "sha512-clean"],
        },
      }),
    );
    const script = path.join(
      import.meta.dir,
      "../scripts/install_security_scanner.ts",
    );
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const { scanner } = await import(${JSON.stringify(script)});
         const found = await scanner.scan({ packages: [] });
         console.log(found.map((item) => item.description).join("\\n"));`,
      ],
      { cwd: lockRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    expect(`${proc.stdout}`).toContain("patch:");
  });

  test("scan reads a workspace manifest pin", () => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    mkdirSync(path.join(workspaceRoot, "packages", "app"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "scanner-workspace", workspaces: ["packages/*"] }),
    );
    writeFileSync(
      path.join(workspaceRoot, "packages", "app", "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { "event-stream": ">=3.3.7 <3.3.8" },
      }),
    );
    const script = path.join(
      import.meta.dir,
      "../scripts/install_security_scanner.ts",
    );
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const { scanner } = await import(${JSON.stringify(script)});
         const found = await scanner.scan({ packages: [] });
         console.log(found.map((item) => item.description).join("\\n"));`,
      ],
      { cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    expect(`${proc.stdout}`).toContain(">=3.3.7 <3.3.8");
  });

  test("bun install does not cancel a file: specifier", () => {
    rmSync(probeRoot, { recursive: true, force: true });
    mkdirSync(path.join(probeRoot, "vendor", "event-stream"), {
      recursive: true,
    });
    writeFileSync(
      path.join(probeRoot, "vendor", "event-stream", "package.json"),
      JSON.stringify({ name: "event-stream", version: "3.3.6" }),
    );
    writeFileSync(
      path.join(probeRoot, "package.json"),
      JSON.stringify({
        name: "scanner-probe",
        dependencies: { "event-stream": "file:./vendor/event-stream" },
      }),
    );
    writeFileSync(
      path.join(probeRoot, "bunfig.toml"),
      '[install.security]\nscanner = "../../scripts/install_security_scanner.ts"\n',
    );
    const home = path.join(probeRoot, "home");
    mkdirSync(home);
    const install = Bun.spawnSync(
      [process.execPath, "install", "--ignore-scripts", "--no-progress"],
      {
        cwd: probeRoot,
        env: {
          PATH: Bun.env.PATH ?? "",
          HOME: home,
          XDG_CONFIG_HOME: home,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = `${install.stdout}\n${install.stderr}`;
    expect(install.exitCode).toBe(0);
    expect(output).not.toContain("FATAL: event-stream");
  });

  test("bunfig points install.security.scanner at this module", () => {
    const config = bunfig as {
      install?: { security?: { scanner?: string } };
    };
    expect(config.install?.security?.scanner).toBe(
      "./scripts/install_security_scanner.ts",
    );
  });

  test("extended offline layer catches compromised packages, dependency confusion, HTTP tarballs, and unpinned git", () => {
    expect(EXTENDED_DENYLIST.length).toBeGreaterThanOrEqual(9);
    expect(canonicalPackageName("＠sportsdesk-ops/contracts")).toBe(
      "@sportsdesk-ops/contracts",
    );

    const uaHit = checkExtendedOfflinePolicy(pkg("ua-parser-js", "0.7.29"));
    expect(uaHit[0]?.level).toBe("fatal");

    const colorsSafe = checkExtendedOfflinePolicy(
      pkg("colors", "1.4.0", {
        tarball: "https://registry.npmjs.org/colors/-/colors-1.4.0.tgz",
      }),
    );
    expect(colorsSafe).toEqual([]);

    const depConfusion = checkExtendedOfflinePolicy(
      pkg("@sportsdesk-ops/internal-sdk", "1.0.0", {
        tarball:
          "https://registry.npmjs.org/@sportsdesk-ops/internal-sdk/-/internal-sdk-1.0.0.tgz",
      }),
    );
    expect(depConfusion[0]?.level).toBe("fatal");
    expect(depConfusion[0]?.description).toContain("dependency confusion");

    const httpTarball = checkExtendedOfflinePolicy(
      pkg("some-lib", "1.0.0", {
        tarball: "http://evil.example/some-lib-1.0.0.tgz",
      }),
    );
    expect(httpTarball[0]?.level).toBe("fatal");

    const unpinnedGit = checkExtendedOfflinePolicy(
      pkg("git-lib", "github:org/repo"),
    );
    expect(unpinnedGit[0]?.level).toBe("warn");
  });

  test("CVSS v3 base score parser computes FIRST.org scores accurately", () => {
    expect(
      parseCvssV3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),
    ).toBe(9.8);
    expect(scoreToSeverity(9.8)).toBe("CRITICAL");
    expect(
      parseCvssV3BaseScore("CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N"),
    ).toBe(5.4);
    expect(scoreToSeverity(5.4)).toBe("MODERATE");
    expect(parseCvssV3BaseScore("invalid")).toBeNull();
  });

  test("opt-in OSV layer caches results in SQLite WAL, scores CVSS v3, and honors fail-closed CI mode", async () => {
    rmSync(osvRoot, { recursive: true, force: true });
    mkdirSync(osvRoot, { recursive: true });
    const cachePath = path.join(osvRoot, "osv.sqlite");

    let batchCalls = 0;
    const mockFetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/v1/querybatch")) {
        batchCalls += 1;
        return Response.json({
          results: [{ vulns: [{ id: "GHSA-sdo-9800" }] }],
        });
      }
      if (url.endsWith("/v1/vulns/GHSA-sdo-9800")) {
        return Response.json({
          id: "GHSA-sdo-9800",
          summary: "Critical CVSS-only test advisory",
          severity: [
            {
              type: "CVSS_V3",
              score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const s = createScanner({
      cwd: osvRoot,
      env: {
        BUN_SCANNER_OSV: "1",
        BUN_SCANNER_CACHE_PATH: cachePath,
      },
      fetchImpl: mockFetch,
    });

    const first = await s.scan({ packages: [pkg("demo-lib", "1.0.0")] });
    expect(batchCalls).toBe(1);
    expect(first).toEqual([
      {
        level: "fatal",
        package: "demo-lib",
        url: "https://osv.dev/vulnerability/GHSA-sdo-9800",
        description:
          "GHSA-sdo-9800 (CRITICAL 9.8): Critical CVSS-only test advisory",
      },
    ]);

    // Second call hits SQLite WAL cache with zero extra OSV requests
    const second = await s.scan({ packages: [pkg("demo-lib", "1.0.0")] });
    expect(batchCalls).toBe(1);
    expect(second).toEqual(first);

    // Cache unit check: stale lookup returns stored IDs after TTL expiry
    const db = openScannerCache(cachePath);
    expect(db?.getPackageVulnsStale("npm:demo-lib@1.0.0")).toEqual([
      "GHSA-sdo-9800",
    ]);
    db?.close();

    // Fail-closed CI mode turns OSV outage into fatal
    const failClosed = createScanner({
      cwd: osvRoot,
      env: {
        BUN_SCANNER_OSV: "1",
        BUN_SCANNER_NO_CACHE: "1",
        BUN_SCANNER_FAIL_CLOSED: "1",
      },
      fetchImpl: (async () => {
        throw new Error("osv unreachable");
      }) as unknown as typeof fetch,
    });
    const outage = await failClosed.scan({
      packages: [pkg("demo-lib", "1.0.0")],
    });
    expect(outage[0]?.level).toBe("fatal");
    expect(outage[0]?.description).toContain("BUN_SCANNER_FAIL_CLOSED=1");
  });
});
