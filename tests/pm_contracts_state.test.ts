import { builtinModules } from "node:module";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => m.replace(/^node:/, "")),
  "bun",
]);

const DEP_GROUPS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Manifest;
}

function workspaceManifests(): Array<{ path: string; manifest: Manifest }> {
  const out: Array<{ path: string; manifest: Manifest }> = [
    { path: "package.json", manifest: readManifest("package.json") },
  ];
  for (const entry of readdirSync(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const path = `packages/${entry.name}/package.json`;
    if (!existsSync(join(root, path))) continue;
    out.push({ path, manifest: readManifest(path) });
  }
  return out;
}

function barePackageName(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier.startsWith("#") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/")
  ) {
    return null;
  }
  const [first, second] = specifier.split("/");
  if (specifier.startsWith("@")) return second ? `${first}/${second}` : null;
  return first ?? null;
}

function stripShebang(source: string): string {
  return source.startsWith("#!")
    ? source.slice(source.indexOf("\n") + 1)
    : source;
}

describe("pm contracts (#34-#35): workspace import closure & lockfile parity", () => {
  test("#34: workspace sources declare every bare import in their own manifest", () => {
    const transpiler = new Bun.Transpiler({ loader: "tsx" });
    const violations: string[] = [];

    for (const { path, manifest } of workspaceManifests()) {
      const pkgDir = path.slice(0, -"/package.json".length);
      const declared = new Set<string>(manifest.name ? [manifest.name] : []);
      for (const group of DEP_GROUPS) {
        for (const dep of Object.keys(manifest[group] ?? {})) declared.add(dep);
      }

      const glob = new Bun.Glob(
        `${pkgDir}/{src,bin,scripts}/**/*.{ts,tsx,mts,cts}`,
      );
      for (const file of glob.scanSync({ cwd: root })) {
        if (file.endsWith(".d.ts")) continue;
        const source = stripShebang(readFileSync(join(root, file), "utf8"));
        for (const imp of transpiler.scanImports(source)) {
          const pkgName = barePackageName(imp.path);
          if (!pkgName || BUILTINS.has(pkgName) || declared.has(pkgName)) {
            continue;
          }
          violations.push(
            `${file} -> undeclared "${pkgName}" (not in ${path})`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("#35: bun.lock workspace keys match live manifests", () => {
    const lock = Bun.JSONC.parse(
      readFileSync(join(root, "bun.lock"), "utf8"),
    ) as {
      workspaces?: Record<string, Record<string, Record<string, string>>>;
    };
    const lockWorkspaces = lock.workspaces ?? {};
    const mismatches: string[] = [];

    for (const { path, manifest } of workspaceManifests()) {
      const wsKey =
        path === "package.json" ? "" : path.slice(0, -"/package.json".length);
      const lockEntry = lockWorkspaces[wsKey];
      if (!lockEntry) {
        mismatches.push(
          `${wsKey || "(root)"}: missing from bun.lock workspaces`,
        );
        continue;
      }
      for (const group of DEP_GROUPS) {
        const liveKeys = Object.keys(manifest[group] ?? {}).sort();
        const lockKeys = Object.keys(lockEntry[group] ?? {}).sort();
        if (JSON.stringify(liveKeys) !== JSON.stringify(lockKeys)) {
          mismatches.push(
            `${wsKey || "(root)"} [${group}]: manifest=[${liveKeys.join(",")}] vs bun.lock=[${lockKeys.join(",")}]`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
