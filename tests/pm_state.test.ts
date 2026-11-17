import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_OWNED_INSTALL_KEYS } from "../lib/pm_policy";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

const DEP_GROUPS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

interface Manifest {
  name?: string;
  private?: boolean;
  publishConfig?: { access?: string; [key: string]: unknown };
  packageExtensions?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

const PINNED_EXT_RE = /^(@[^/]+\/[^@]+|[^@/]+)@\d+(\.\d+)*$/;

function hasNestedKey(
  obj: Record<string, unknown> | undefined,
  dottedKey: string,
): boolean {
  let cur: unknown = obj;
  for (const part of dottedKey.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur !== undefined;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Manifest;
}

describe("PM state invariants", () => {
  test("the runtime pin is 1.4.4", () => {
    expect(readFileSync(join(root, ".bun-version"), "utf8").trim()).toBe(
      "1.4.4",
    );
  });

  test("predev and test:pm-contracts are wired", () => {
    expect(pkg.scripts?.predev ?? "").toContain("check:pm-state");
    expect(pkg.scripts?.["test:pm-contracts"] ?? "").toContain(
      "bun_pm_behaviors.test.ts",
    );
  });

  test("the lockfile is present", () => {
    expect(existsSync(join(root, "bun.lock"))).toBe(true);
  });

  test("bunfig.toml omits machine-owned install keys", () => {
    const parsed = Bun.TOML.parse(
      readFileSync(join(root, "bunfig.toml"), "utf8"),
    ) as { install?: Record<string, unknown> };
    const installBlock = parsed.install ?? {};
    const leaked = MACHINE_OWNED_INSTALL_KEYS.filter((key) =>
      hasNestedKey(installBlock, key),
    );
    expect(leaked).toEqual([]);
  });

  test("root is private and non-private workspaces opt in via publishConfig", () => {
    const rootPkg = readManifest("package.json");
    expect(rootPkg.private).toBe(true);

    const violations: string[] = [];
    manifestPaths().forEach((path) => {
      const manifest = readManifest(path);
      if (!manifest.name) violations.push(`${path}: missing "name"`);

      for (const extKey of Object.keys(manifest.packageExtensions ?? {})) {
        if (!PINNED_EXT_RE.test(extKey)) {
          violations.push(
            `${path}: unpinned packageExtensions key "${extKey}"`,
          );
        }
      }

      if (path !== "package.json") {
        const optIn = typeof manifest.publishConfig?.access === "string";
        if (manifest.private !== true && !optIn) {
          violations.push(
            `${path}: must be "private": true or declare publishConfig.access`,
          );
        }
      }

      const seen = new Map<string, string[]>();
      for (const group of DEP_GROUPS) {
        for (const [dep, spec] of Object.entries(manifest[group] ?? {})) {
          seen.set(dep, [...(seen.get(dep) ?? []), group]);
          if (
            spec.startsWith("link:") &&
            !spec.startsWith("link:./") &&
            !spec.startsWith("link:../") &&
            !spec.startsWith("link:/")
          ) {
            violations.push(`${path}: bare link specifier "${dep}"`);
          }
        }
      }
      for (const [dep, groups] of seen) {
        if (groups.length > 1) {
          violations.push(
            `${path}: "${dep}" duplicated across [${groups.join(", ")}]`,
          );
        }
      }
    });

    expect(violations).toEqual([]);
  });
});

function manifestPaths(): string[] {
  const paths = ["package.json"];
  for (const entry of readdirSync(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (
      entry.isDirectory() &&
      existsSync(join(root, "packages", entry.name, "package.json"))
    ) {
      paths.push(`packages/${entry.name}/package.json`);
    }
  }
  return paths;
}
