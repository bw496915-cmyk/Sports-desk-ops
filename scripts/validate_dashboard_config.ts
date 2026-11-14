// scripts/validate_dashboard_config.ts
//
// Bun-only: uses the `bun:` module (TOML, Glob), Bun.file, Bun.spawnSync.
// Does not run under Node.
//
// Runs after buildEnhancedDashboard() has emitted to dist/dashboard/.
// Does not replace the builder and does not spawn `bun build` itself.
//
// VALIDATION-SCOPE CAVEAT: this validates the bytes that get inlined only while
// the dashboard TOML imports remain static. A runtime override (fetch,
// per-tenant, A/B variant) invalidates both the validation and the tree-shake.
//
// Date contract: quoted strings only. Unquoted TOML dates parse to
// Temporal.Instant / PlainDateTime / PlainDate / PlainTime and crash the
// browser bundle at module load.
//
// REQUIRED_PROBE must be a leaf key a component actually reads. It is `sharp`,
// rendered by packages/ui/src/panels/ThresholdsPanel.tsx. Update this constant
// in the same change as any refactor of that panel.

import { Glob, TOML } from "bun";

const CONFIG_GLOB = "packages/ui/src/config/*.toml";
const SOURCE_ROOTS = ["src/dashboard", "packages/ui/src"] as const;
const DIST_DIR = "dist/dashboard";
const REQUIRED_PROBE = "sharp"; // rendered by ThresholdsPanel
const SENTINEL_PROBE = "churn"; // defined in the TOML, never imported

type Issue = { path: string; message: string };

export function temporalType(v: unknown): string | null {
  const m =
    /^\[object Temporal\.(Instant|PlainDateTime|PlainDate|PlainTime)\]$/.exec(
      Object.prototype.toString.call(v),
    );
  return m ? m[1]! : null;
}

export function findTemporal(value: unknown, path = "$"): string[] {
  const t = temporalType(value);
  if (t) return [`${path} is Temporal.${t} (quote it as a string)`];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findTemporal(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      findTemporal(v, `${path}.${k}`),
    );
  }
  return [];
}

export function hasKeyDeep(obj: unknown, key: string): boolean {
  if (Array.isArray(obj)) return obj.some((v) => hasKeyDeep(v, key));
  if (obj && typeof obj === "object") {
    return Object.entries(obj).some(
      ([k, v]) => k === key || hasKeyDeep(v, key),
    );
  }
  return false;
}

export function checkSchema(v: unknown, file: string): Issue[] {
  const out: Issue[] = [];
  if (!v || typeof v !== "object") {
    return [{ path: file, message: "$ is not a table" }];
  }
  const doc = v as Record<string, unknown>;
  const thresholds = doc.thresholds as Record<string, unknown> | undefined;
  if (thresholds != null) {
    if (typeof thresholds !== "object") {
      out.push({ path: file, message: "thresholds must be a table" });
    } else if (typeof thresholds.sharp !== "number") {
      out.push({ path: file, message: "thresholds.sharp must be a number" });
    }
  }
  const leagues = doc.leagues as Record<string, unknown> | undefined;
  if (leagues != null) {
    const names = leagues.names;
    if (!Array.isArray(names)) {
      out.push({ path: file, message: "leagues.names must be an array" });
    } else {
      names.forEach((name, i) => {
        if (typeof name !== "string") {
          out.push({
            path: file,
            message: `leagues.names[${i}] must be a string`,
          });
        }
      });
    }
  }
  const api = doc.api;
  if (api != null) {
    if (typeof api !== "object") {
      out.push({ path: file, message: "api must be a table" });
    } else {
      const table = api as Record<string, unknown>;
      if (table.base != null && typeof table.base !== "string") {
        out.push({ path: file, message: "api.base must be a string" });
      }
      for (const key of ["tiers", "customers", "wagers", "dashboard"]) {
        const value = table[key];
        if (typeof value !== "string" || !value.startsWith("/")) {
          out.push({
            path: file,
            message: `api.${key} must be a path starting with "/"`,
          });
        }
      }
    }
  }

  const freshness = doc.freshness;
  if (freshness != null) {
    if (typeof freshness !== "object") {
      out.push({ path: file, message: "freshness must be a table" });
    } else {
      const stale = (freshness as Record<string, unknown>).stale_after_minutes;
      if (typeof stale !== "number" || stale <= 0) {
        out.push({
          path: file,
          message: "freshness.stale_after_minutes must be a positive number",
        });
      }
    }
  }

  return out;
}

async function anyTomlImported(): Promise<boolean> {
  const re = /\bimport\b[^;]*?from\s*["'][^"']+\.toml["']/;
  for (const root of SOURCE_ROOTS) {
    for await (const file of new Glob("**/*.{ts,tsx,html}").scan(root)) {
      const path = file.startsWith(root) ? file : `${root}/${file}`;
      if (re.test(await Bun.file(path).text())) return true;
    }
  }
  return false;
}

async function bundleContents(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for await (const file of new Glob("*.js").scan(DIST_DIR)) {
      out.set(file, await Bun.file(`${DIST_DIR}/${file}`).text());
    }
  } catch (e) {
    throw new Error(
      `cannot read ${DIST_DIR}: ${(e as Error).message} — did the build run?`,
      { cause: e },
    );
  }
  if (out.size === 0) {
    throw new Error(`no .js files under ${DIST_DIR} — did the build run?`);
  }
  return out;
}

export async function validateDashboardConfig(): Promise<void> {
  const files = await Array.fromAsync(new Glob(CONFIG_GLOB).scan("."));
  if (files.length === 0) {
    throw new Error(`no config files matched ${CONFIG_GLOB}`);
  }

  const issues: Issue[] = [];
  const parsed: unknown[] = [];
  for (const file of files) {
    const text = await Bun.file(file).text();
    let value: unknown;
    try {
      value = TOML.parse(text);
    } catch (e) {
      issues.push({
        path: file,
        message: `TOML parse error: ${(e as Error).message}`,
      });
      continue;
    }
    parsed.push(value);
    issues.push(
      ...findTemporal(value).map((m) => ({ path: file, message: m })),
    );
    issues.push(...checkSchema(value, file));
  }
  if (issues.length) {
    for (const issue of issues) {
      console.error(`✗ ${issue.path}: ${issue.message}`);
    }
    throw new Error(`${issues.length} config issue(s)`);
  }

  // Absence in the bundle proves nothing if the key was never defined.
  if (!parsed.some((v) => hasKeyDeep(v, REQUIRED_PROBE))) {
    throw new Error(
      `config missing required probe "${REQUIRED_PROBE}" — add it to the TOML or update REQUIRED_PROBE`,
    );
  }
  if (!parsed.some((v) => hasKeyDeep(v, SENTINEL_PROBE))) {
    throw new Error(
      `config missing sentinel probe "${SENTINEL_PROBE}" — add it to the TOML or update SENTINEL_PROBE`,
    );
  }
  console.log(`✓ ${files.length} config file(s) valid, probes present`);

  if (!(await anyTomlImported())) {
    console.log(
      "· tree-shake check skipped: no dashboard source imports a .toml yet",
    );
    return;
  }

  const flat = [...(await bundleContents()).entries()];
  const sentinelHit = flat.find(([, text]) => text.includes(SENTINEL_PROBE));
  if (sentinelHit) {
    throw new Error(
      `tree-shake broken: "${SENTINEL_PROBE}" appears in ${sentinelHit[0]}`,
    );
  }
  const requiredHit = flat.find(([, text]) => text.includes(REQUIRED_PROBE));
  if (!requiredHit) {
    throw new Error(
      `config not inlined: "${REQUIRED_PROBE}" absent from every bundle in ${DIST_DIR}`,
    );
  }
  console.log(
    `✓ tree-shake intact: "${REQUIRED_PROBE}" present in ${requiredHit[0]}, "${SENTINEL_PROBE}" absent`,
  );
}

if (import.meta.main) {
  try {
    const { buildEnhancedDashboard } = await import("./build_dashboard");
    await buildEnhancedDashboard();
    await validateDashboardConfig();
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
