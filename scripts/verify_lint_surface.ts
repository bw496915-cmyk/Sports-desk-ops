#!/usr/bin/env bun
/**
 * @file scripts/verify_lint_surface.ts
 * @description Hardened 4-stage preflight verifier for Bun's native linter surface:
 *   Stage 1: Validate bunfig.toml ([lint.rules] + [[lint.overrides]][].rules) and
 *            .oxlintrc*.json against `bun lint --no-script --rules -f json`.
 *   Stage 2: Verify `bun lint --no-script --explain <rule>` for every required active rule.
 *   Stage 3: Verify `bun lint --no-script --print-config <target>` resolves active severities
 *            (`"deny"` / `"warn"` / `"error"` / `1` / `2`) across domain-isolated entrypoints.
 *   Stage 4: Run `bun lint --no-script --doctor` and inspect output for unsupported rules or
 *            legacy ESLint config bleed (accounting for oven-sh/bun#49393 where exit code is 0).
 *
 * Usage:
 *   bun run lint:verify-surface
 *   bun run lint:verify-surface --json
 */

import { access, constants } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveNativeBunLintBin } from "./lint_native.ts";

export const EXIT_OK = 0;
export const EXIT_DATAERR = 65;
export const EXIT_UNAVAILABLE = 69;
export const EXIT_SOFTWARE = 70;
export const EXIT_TEMPFAIL = 75;

const CMD_TIMEOUT_MS = 15_000;
const SEVERITY_WARN = 1;
const SEVERITY_ERROR = 2;

export const ERROR_CODES = {
  ERR_OPS_BINARY_MISSING: EXIT_UNAVAILABLE,
  ERR_LINT_CATALOG_FAILED: EXIT_SOFTWARE,
  ERR_LINT_UNKNOWN_RULE: EXIT_DATAERR,
  ERR_LINT_CONFIG_DRIFT: EXIT_DATAERR,
  ERR_LINT_DOCTOR_UNSUPPORTED: EXIT_DATAERR,
  ERR_SPAWN_TIMEOUT_KILLED: EXIT_TEMPFAIL,
} as const;

export type LintSurfaceErrorCode = keyof typeof ERROR_CODES;

export const DEFAULT_DOMAIN_TARGETS = [
  "packages/contracts/src/index.ts",
  "packages/api/src/router.ts",
  "packages/backend/src/r2_pipeline.ts",
  "lib/bun_runtime_pin.ts",
  "scripts/lint_native.ts",
] as const;

/** Active base rules mirrored across `.oxlintrc.json` and `bunfig.toml` `[lint.rules]`. */
export const REQUIRED_ACTIVE_RULES = [
  "eqeqeq",
  "typescript/no-explicit-any",
  "typescript/no-require-imports",
  "preserve-caught-error",
  "unicorn/require-module-attributes",
  "unicorn/prefer-array-flat-map",
  "bun:test/prefer-snapshot-hint",
  "bun:test/no-large-snapshots",
  "bun:test/no-interpolation-in-snapshots",
  "bun/no-literal-temp-dir",
] as const;

export interface CmdResult {
  readonly code: number;
  readonly signalCode: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BunfigLint {
  readonly rules?: Readonly<Record<string, unknown>>;
  readonly overrides?: ReadonlyArray<{
    readonly files?: string | ReadonlyArray<string>;
    readonly rules?: Readonly<Record<string, unknown>>;
  }>;
}

export interface LintSurfaceFailure {
  readonly code: LintSurfaceErrorCode;
  readonly detail: string;
}

export interface ExplainCheckResult {
  readonly rule: string;
  readonly exitCode: number;
  readonly ok: boolean;
}

export interface ConfigCheckResult {
  readonly target: string;
  readonly exitCode: number;
  readonly activeRequiredRules: string;
  readonly missingRules: readonly string[];
}

export interface LintSurfaceReport {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly bunBin: string | null;
  readonly catalogCount: number;
  readonly warnings: readonly string[];
  readonly failures: readonly LintSurfaceFailure[];
  readonly explainChecks: readonly ExplainCheckResult[];
  readonly configChecks: readonly ConfigCheckResult[];
  readonly doctor: {
    readonly exitCode: number;
    readonly findings: readonly string[];
  };
}

/** Normalize `@typescript-eslint/*` and `eslint/*` aliases to Bun/oxlint canonical names. */
export function normalizeRuleName(rule: string): string {
  return rule
    .trim()
    .replace(/^@typescript-eslint\//, "typescript/")
    .replace(/^eslint\//, "")
    .replace(/^bun-test\//, "bun:test/");
}

/**
 * Extract canonical rule names from `bun lint --no-script --rules -f json`.
 * Supports string arrays, `{ name }` / `{ rule }`, and oxlint `{ scope, value }` entries.
 */
export function extractCatalogRuleNames(catalogRaw: unknown): Set<string> {
  const valid = new Set<string>();
  if (!Array.isArray(catalogRaw)) return valid;
  for (const entry of catalogRaw) {
    if (typeof entry === "string") {
      const norm = normalizeRuleName(entry);
      if (norm !== "") valid.add(norm);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const direct =
      typeof rec.name === "string"
        ? rec.name
        : typeof rec.rule === "string"
          ? rec.rule
          : null;
    if (direct !== null && direct.trim() !== "") {
      valid.add(normalizeRuleName(direct));
    }
    const scope = typeof rec.scope === "string" ? rec.scope.trim() : "";
    const value = typeof rec.value === "string" ? rec.value.trim() : "";
    if (value !== "") {
      if (scope === "" || scope === "eslint") {
        valid.add(value);
      } else {
        const canonicalScope = scope === "bun-test" ? "bun:test" : scope;
        valid.add(normalizeRuleName(`${canonicalScope}/${value}`));
        valid.add(`${scope}/${value}`);
      }
    }
  }
  return valid;
}

/**
 * Bun/oxlint `--print-config` emits `"deny"` / `"warn"` (or `1` / `2` / `"error"` / tuple forms).
 */
export function isRuleActive(entry: unknown): boolean {
  const severity = Array.isArray(entry) ? entry[0] : entry;
  return (
    severity === SEVERITY_WARN ||
    severity === SEVERITY_ERROR ||
    severity === "warn" ||
    severity === "error" ||
    severity === "deny"
  );
}

/**
 * Slice the outer JSON object before `JSON.parse` so a trailing `note:` line
 * (oven-sh/bun#47174) never breaks parsing.
 */
export function parsePrintConfigJson(
  raw: string,
): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Inspect `bun lint --no-script --doctor` output for unsupported/JS-hosted rule notices
 * or legacy ESLint config bleed (since `--doctor` may exit 0 per oven-sh/bun#49393).
 */
export function inspectDoctorOutput(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`;
  const findings: string[] = [];
  const patterns: readonly { readonly re: RegExp; readonly label: string }[] = [
    {
      re: /\bunsupported\b.*\brule/i,
      label: "unsupported rule reported by --doctor",
    },
    {
      re: /\bunknown\s+rule/i,
      label: "unknown rule reported by --doctor",
    },
    {
      re: /\bjs[- ]hosted\b|\bjs plugin\b/i,
      label: "JS-hosted/plugin rule reported by --doctor",
    },
    {
      re: /\blegacy\s+eslint\b|\.eslintrc/i,
      label: "legacy ESLint config detected by --doctor",
    },
  ];
  for (const line of combined.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    for (const { re, label } of patterns) {
      if (re.test(trimmed)) {
        findings.push(`${label}: ${trimmed}`);
        break;
      }
    }
  }
  return findings;
}

export function buildSanitizedEnv(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): Record<string, string> {
  const homeDir = env.HOME?.trim() || homedir();
  return {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: homeDir,
    TMPDIR: env.TMPDIR ?? tmpdir(),
    LANG: env.LANG ?? "en_US.UTF-8",
    NODE_ENV: env.NODE_ENV ?? "production",
  };
}

export async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runLintCmd(
  bin: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
  } = {},
): Promise<CmdResult> {
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    cwd: options.cwd ?? process.cwd(),
    env: buildSanitizedEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    signal: AbortSignal.timeout(options.timeoutMs ?? CMD_TIMEOUT_MS),
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout.text(),
    proc.stderr.text(),
  ]);
  return {
    code,
    signalCode: proc.signalCode === null ? null : String(proc.signalCode),
    stdout,
    stderr,
  };
}

export interface VerifyLintSurfaceOptions {
  readonly cwd?: string;
  readonly bin?: string | null;
  readonly targets?: readonly string[];
  readonly requiredRules?: readonly string[];
  readonly runCmd?: (
    bin: string,
    args: readonly string[],
  ) => Promise<CmdResult>;
}

export async function verifyLintSurface(
  options: VerifyLintSurfaceOptions = {},
): Promise<LintSurfaceReport> {
  const cwd = options.cwd ?? process.cwd();
  const targets = options.targets ?? DEFAULT_DOMAIN_TARGETS;
  const requiredRules = options.requiredRules ?? REQUIRED_ACTIVE_RULES;
  const warnings: string[] = [];
  const failures: LintSurfaceFailure[] = [];
  let exitCode: number = EXIT_OK;

  const recordFailure = (code: LintSurfaceErrorCode, detail: string): void => {
    failures.push({ code, detail });
    if (exitCode === EXIT_OK) exitCode = ERROR_CODES[code];
  };

  const resolvedBin =
    options.bin !== undefined ? options.bin : resolveNativeBunLintBin();
  if (
    resolvedBin === null ||
    (options.bin === undefined && !(await isExecutable(resolvedBin)))
  ) {
    recordFailure(
      "ERR_OPS_BINARY_MISSING",
      "no native `bun lint` binary found (requires Bun canary / BUN_LINT_BIN / ~/.bun-canary/bin/bun)",
    );
    return {
      ok: false,
      exitCode,
      bunBin: null,
      catalogCount: 0,
      warnings,
      failures,
      explainChecks: [],
      configChecks: [],
      doctor: { exitCode: EXIT_UNAVAILABLE, findings: [] },
    };
  }

  const exec =
    options.runCmd ?? ((bin, args) => runLintCmd(bin, args, { cwd }));

  // Stage 1: Validate bunfig.toml ([lint.rules] + [[lint.overrides]][].rules) and .oxlintrc*.json
  const [rulesRes, bunfigText, oxlintText, typeAwareText] = await Promise.all([
    exec(resolvedBin, ["lint", "--no-script", "--rules", "-f", "json"]),
    Bun.file(resolve(cwd, "bunfig.toml"))
      .text()
      .catch(() => ""),
    Bun.file(resolve(cwd, ".oxlintrc.json"))
      .text()
      .catch(() => ""),
    Bun.file(resolve(cwd, ".oxlintrc.type-aware.json"))
      .text()
      .catch(() => ""),
  ]);

  let catalogCount = 0;
  if (rulesRes.signalCode !== null) {
    recordFailure(
      "ERR_SPAWN_TIMEOUT_KILLED",
      `rules catalog killed by ${rulesRes.signalCode}`,
    );
  } else if (rulesRes.code !== EXIT_OK) {
    recordFailure(
      "ERR_LINT_CATALOG_FAILED",
      rulesRes.stderr.trim() || `exit=${rulesRes.code}`,
    );
  } else {
    let catalogRaw: unknown;
    try {
      catalogRaw = JSON.parse(rulesRes.stdout);
    } catch (err) {
      recordFailure(
        "ERR_LINT_CATALOG_FAILED",
        `invalid JSON from --rules -f json: ${err instanceof Error ? err.message : String(err)}`,
      );
      catalogRaw = [];
    }
    const validRules = extractCatalogRuleNames(catalogRaw);
    catalogCount = validRules.size;

    const configuredRules = new Set<string>();
    const rootRules: string[] = [];
    const overrideRules: string[] = [];

    if (bunfigText !== "") {
      const parsed = Bun.TOML.parse(bunfigText) as {
        readonly lint?: BunfigLint;
      };
      for (const rule of Object.keys(parsed.lint?.rules ?? {})) {
        rootRules.push(rule);
        configuredRules.add(normalizeRuleName(rule));
      }
      for (const ov of parsed.lint?.overrides ?? []) {
        for (const rule of Object.keys(ov.rules ?? {})) {
          overrideRules.push(rule);
          configuredRules.add(normalizeRuleName(rule));
        }
      }
    }

    for (const jsonText of [oxlintText, typeAwareText]) {
      if (jsonText === "") continue;
      const parsed = JSON.parse(jsonText) as {
        readonly rules?: Readonly<Record<string, unknown>>;
      };
      for (const rule of Object.keys(parsed.rules ?? {})) {
        configuredRules.add(normalizeRuleName(rule));
      }
    }

    const unknown = [...configuredRules].filter(
      (rule) => !rule.endsWith("/*") && !validRules.has(rule),
    );
    if (unknown.length > 0) {
      recordFailure("ERR_LINT_UNKNOWN_RULE", unknown.sort().join(", "));
    }

    if (
      rootRules.includes("no-restricted-imports") &&
      overrideRules.includes("no-restricted-imports")
    ) {
      warnings.push(
        "WARN_LINT_OVERRIDE_SHADOW: [[lint.overrides]] redefines no-restricted-imports (replaces root paths)",
      );
    }
  }

  // Stage 2: Verify --explain for all required active policy rules
  const explainChecks = await Promise.all(
    requiredRules.map(async (rule): Promise<ExplainCheckResult> => {
      const res = await exec(resolvedBin, [
        "lint",
        "--no-script",
        "--explain",
        rule,
      ]);
      if (res.signalCode !== null) {
        recordFailure(
          "ERR_SPAWN_TIMEOUT_KILLED",
          `--explain ${rule} killed by ${res.signalCode}`,
        );
        return { rule, exitCode: EXIT_TEMPFAIL, ok: false };
      }
      const ok = res.code === EXIT_OK && res.stdout.trim().length > 0;
      if (!ok) {
        recordFailure(
          "ERR_LINT_UNKNOWN_RULE",
          `--explain ${rule} failed (exit=${res.code})`,
        );
      }
      return { rule, exitCode: res.code, ok };
    }),
  );

  // Stage 3: Verify --print-config resolved severities on each domain target
  const configChecks = await Promise.all(
    targets.map(async (target): Promise<ConfigCheckResult> => {
      const absPath = resolve(cwd, target);
      if (!(await Bun.file(absPath).exists())) {
        recordFailure(
          "ERR_LINT_CONFIG_DRIFT",
          `missing domain target ${target}`,
        );
        return {
          target,
          exitCode: EXIT_DATAERR,
          activeRequiredRules: "MISSING",
          missingRules: [...requiredRules],
        };
      }
      const res = await exec(resolvedBin, [
        "lint",
        "--no-script",
        "--print-config",
        target,
      ]);
      if (res.signalCode !== null) {
        recordFailure(
          "ERR_SPAWN_TIMEOUT_KILLED",
          `--print-config ${target} killed by ${res.signalCode}`,
        );
        return {
          target,
          exitCode: EXIT_TEMPFAIL,
          activeRequiredRules: "TIMEOUT",
          missingRules: [...requiredRules],
        };
      }
      const cfg =
        res.code === EXIT_OK ? parsePrintConfigJson(res.stdout) : null;
      const rawRules = (cfg?.rules ?? {}) as Record<string, unknown>;
      const normalizedMap = new Map<string, unknown>();
      for (const [k, v] of Object.entries(rawRules)) {
        normalizedMap.set(normalizeRuleName(k), v);
      }
      const missingRules = requiredRules.filter(
        (rule) => !isRuleActive(normalizedMap.get(normalizeRuleName(rule))),
      );
      if (res.code !== EXIT_OK || cfg === null || missingRules.length > 0) {
        recordFailure(
          "ERR_LINT_CONFIG_DRIFT",
          `${target} (exit=${res.code}, inactive=[${missingRules.join(", ")}])`,
        );
      }
      return {
        target,
        exitCode: res.code,
        activeRequiredRules: `${requiredRules.length - missingRules.length}/${requiredRules.length}`,
        missingRules,
      };
    }),
  );

  // Stage 4: Run --doctor audit and inspect output (oven-sh/bun#49393)
  const doctorRes = await exec(resolvedBin, [
    "lint",
    "--no-script",
    "--doctor",
  ]);
  const doctorFindings = inspectDoctorOutput(
    doctorRes.stdout,
    doctorRes.stderr,
  );
  if (doctorRes.signalCode !== null) {
    recordFailure(
      "ERR_SPAWN_TIMEOUT_KILLED",
      `--doctor killed by ${doctorRes.signalCode}`,
    );
  } else if (doctorRes.code !== EXIT_OK) {
    recordFailure("ERR_LINT_CONFIG_DRIFT", `--doctor exited ${doctorRes.code}`);
  } else if (doctorFindings.length > 0) {
    recordFailure("ERR_LINT_DOCTOR_UNSUPPORTED", doctorFindings.join("; "));
  }

  return {
    ok: failures.length === 0,
    exitCode,
    bunBin: resolvedBin,
    catalogCount,
    warnings,
    failures,
    explainChecks,
    configChecks,
    doctor: { exitCode: doctorRes.code, findings: doctorFindings },
  };
}

if (import.meta.main) {
  const jsonMode = Bun.argv.slice(2).includes("--json");
  const report = await verifyLintSurface();
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `lint:verify-surface: ${report.ok ? "PASS" : "FAIL"} (bin=${report.bunBin ?? "none"}, catalog=${report.catalogCount}, explain=${report.explainChecks.filter((c) => c.ok).length}/${report.explainChecks.length}, targets=${report.configChecks.length}, doctor=${report.doctor.exitCode})`,
    );
    for (const warning of report.warnings) console.warn(`  WARN  ${warning}`);
    for (const failure of report.failures) {
      console.error(`  FAIL  ${failure.code}: ${failure.detail}`);
    }
  }
  process.exitCode = report.exitCode;
}
