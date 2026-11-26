#!/usr/bin/env bun
/**
 * @file scripts/verify_lint_surface.ts
 * @description Hardened 4-stage native `bun lint --no-script` preflight verifier aligned to
 * `sportsdesk-ops`'s actual `bunfig.toml` `[lint]` policy and domain entrypoints.
 *
 * Stages:
 * 1. Validate every rule in `bunfig.toml` `[lint.rules]` and `[[lint.overrides]][].rules`
 *    against `bun lint --no-script --rules -f json`, and warn if an override shadows
 *    `no-restricted-imports`.
 * 2. Run `bun lint --no-script --explain <rule>` for every required active policy rule.
 * 3. Run `bun lint --no-script --print-config <target>` on real domain entrypoints, slicing
 *    around any trailing `note:` line (oven-sh/bun#47174) and asserting numeric/string active
 *    severity (`1` / `2` / `"warn"` / `"error"`), failing closed on missing targets.
 * 4. Run `bun lint --no-script --doctor` and inspect output for unsupported / JS-hosted rules
 *    (oven-sh/bun#49393).
 */

import { access, constants } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { detectBunReleaseChannel } from "@sportsdesk-ops/contracts/bun-release-channel";
import { hasNativeBunLint, resolveNativeBunLintBin } from "./lint_native.ts";

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
  ERR_SPAWN_TIMEOUT_KILLED: EXIT_TEMPFAIL,
} as const;

export type LintSurfaceErrorCode = keyof typeof ERROR_CODES;

/** Actual domain-isolated entrypoints in `sportsdesk-ops`. */
export const DOMAIN_TARGETS = [
  "packages/contracts/src/index.ts",
  "lib/gslive_session.ts",
  "lib/gslive_manager_endpoints.ts",
  "lib/r2_s3_client.ts",
] as const;

/** Core active policy rules enforced in `sportsdesk-ops/bunfig.toml` (`[lint.rules]`). */
export const REQUIRED_ACTIVE_RULES = [
  "unicorn/require-module-attributes",
  "unicorn/prefer-array-flat-map",
  "eqeqeq",
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-require-imports",
  "preserve-caught-error",
] as const;

export interface CmdResult {
  readonly code: number;
  readonly signalCode: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BunfigLintSection {
  readonly rules?: Record<string, unknown>;
  readonly overrides?: ReadonlyArray<{
    readonly files?: ReadonlyArray<string>;
    readonly rules?: Record<string, unknown>;
  }>;
}

export function buildSanitizedEnv(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): Record<string, string> {
  return {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: env.HOME ?? homedir(),
    TMPDIR: env.TMPDIR ?? tmpdir(),
    LANG: env.LANG ?? "en_US.UTF-8",
    NODE_ENV: env.NODE_ENV ?? "production",
  };
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an executable Bun binary that actually ships native `bun lint` (`Usage: bun lint`),
 * failing closed with `ERR_OPS_BINARY_MISSING` on stable `1.4.5` when no canary is provisioned.
 */
export async function resolveNativeLintExecutable(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<string | null> {
  const candidate = resolveNativeBunLintBin(env);
  if (
    candidate !== null &&
    (await isExecutable(candidate)) &&
    hasNativeBunLint(candidate)
  ) {
    return candidate;
  }
  return null;
}

/** Parse `--rules -f json`; return null instead of throwing on malformed output. */
export function parseRuleCatalog(raw: string): readonly string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const rules = parsed
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry !== null && typeof entry === "object"
            ? String(
                (entry as { readonly name?: unknown; readonly rule?: unknown })
                  .name ??
                  (entry as { readonly rule?: unknown }).rule ??
                  "",
              )
            : "",
      )
      .filter((rule) => rule.length > 0);
    return rules.length > 0 ? rules : null;
  } catch {
    return null;
  }
}

export function isRuleActive(entry: unknown): boolean {
  const severity = Array.isArray(entry) ? entry[0] : entry;
  return (
    severity === SEVERITY_WARN ||
    severity === SEVERITY_ERROR ||
    severity === "warn" ||
    severity === "error"
  );
}

/**
 * Parse `--print-config` JSON safely even if Bun appends a trailing `note:` line
 * (oven-sh/bun#47174).
 */
export function parsePrintConfigJson(
  raw: string,
): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Audit `bunfig.toml` `[lint.rules]` + `[[lint.overrides]][].rules` against the native catalog. */
export function auditBunfigLintRules(
  bunfigText: string,
  validRules: ReadonlySet<string>,
): {
  readonly unknownRules: readonly string[];
  readonly shadowsRestrictedImports: boolean;
} {
  const parsed = Bun.TOML.parse(bunfigText) as {
    readonly lint?: BunfigLintSection;
  };
  const rootRules = Object.keys(parsed.lint?.rules ?? {});
  const overrideRules = (parsed.lint?.overrides ?? []).flatMap((ov) =>
    Object.keys(ov.rules ?? {}),
  );
  const unknownRules = [...new Set([...rootRules, ...overrideRules])].filter(
    (rule) => !rule.endsWith("/*") && !validRules.has(rule),
  );
  const shadowsRestrictedImports =
    rootRules.includes("no-restricted-imports") &&
    overrideRules.includes("no-restricted-imports");
  return { unknownRules, shadowsRestrictedImports };
}

/** Detect unsupported / JS-hosted rule warnings in `bun lint --doctor` output (oven-sh/bun#49393). */
export function findDoctorUnsupportedLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /\b(unsupported|js-hosted|unknown rule|not supported)\b/i.test(line),
    );
}

async function runCmd(
  bin: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<CmdResult> {
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    cwd,
    env: buildSanitizedEnv(),
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    signal: AbortSignal.timeout(CMD_TIMEOUT_MS),
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  return {
    code,
    signalCode: proc.signalCode === null ? null : String(proc.signalCode),
    stdout,
    stderr,
  };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  let exitCode: number = EXIT_OK;
  const recordFailure = (code: LintSurfaceErrorCode, detail: string): void => {
    console.error(`${code}: ${detail}`);
    if (exitCode === EXIT_OK) exitCode = ERROR_CODES[code];
  };

  const bunBin = await resolveNativeLintExecutable();
  if (bunBin === null) {
    recordFailure(
      "ERR_OPS_BINARY_MISSING",
      `no executable native \`bun lint\` binary found (active Bun ${Bun.version} [${detectBunReleaseChannel(Bun.version)}]); set BUN_LINT_BIN or install $HOME/.bun-canary/bin/bun`,
    );
    process.exitCode = exitCode;
    return;
  }

  // Stage 1: Validate bunfig.toml [lint.rules] and [[lint.overrides]][].rules against --rules -f json
  const [rulesRes, bunfigRead] = await Promise.all([
    runCmd(bunBin, ["lint", "--no-script", "--rules", "-f", "json"], cwd),
    Bun.file(resolve(cwd, "bunfig.toml"))
      .text()
      .then((text) => ({ ok: true as const, text }))
      .catch(() => ({ ok: false as const, text: "" })),
  ]);

  if (!bunfigRead.ok) {
    recordFailure(
      "ERR_LINT_CONFIG_DRIFT",
      "bunfig.toml is missing or unreadable",
    );
  }
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
    const catalog = parseRuleCatalog(rulesRes.stdout);
    if (catalog === null) {
      recordFailure(
        "ERR_LINT_CATALOG_FAILED",
        "catalog was not valid JSON rule metadata",
      );
    } else if (bunfigRead.ok) {
      try {
        const { unknownRules, shadowsRestrictedImports } = auditBunfigLintRules(
          bunfigRead.text,
          new Set(catalog),
        );
        if (unknownRules.length > 0) {
          recordFailure("ERR_LINT_UNKNOWN_RULE", unknownRules.join(", "));
        }
        if (shadowsRestrictedImports) {
          console.warn(
            "WARN_LINT_OVERRIDE_SHADOW: [[lint.overrides]] redefines no-restricted-imports (replaces root paths)",
          );
        }
      } catch (error) {
        recordFailure(
          "ERR_LINT_CONFIG_DRIFT",
          `bunfig.toml could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Stage 2: Verify --explain for every required active policy rule
  const explainChecks = await Promise.all(
    REQUIRED_ACTIVE_RULES.map(async (rule) => {
      const res = await runCmd(
        bunBin,
        ["lint", "--no-script", "--explain", rule],
        cwd,
      );
      if (res.signalCode !== null) {
        recordFailure(
          "ERR_SPAWN_TIMEOUT_KILLED",
          `--explain ${rule} killed by ${res.signalCode}`,
        );
      } else if (res.code !== EXIT_OK) {
        recordFailure(
          "ERR_LINT_UNKNOWN_RULE",
          `--explain ${rule} failed (exit=${res.code})`,
        );
      }
      return { rule, exitCode: res.code };
    }),
  );

  // Stage 3: Verify --print-config active severity across real domain entrypoints
  const configChecks = await Promise.all(
    DOMAIN_TARGETS.map(async (target) => {
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
        };
      }
      const res = await runCmd(
        bunBin,
        ["lint", "--no-script", "--print-config", target],
        cwd,
      );
      const cfg =
        res.code === EXIT_OK ? parsePrintConfigJson(res.stdout) : null;
      const rulesMap = (cfg?.rules ?? {}) as Record<string, unknown>;
      const missing = REQUIRED_ACTIVE_RULES.filter(
        (rule) => !isRuleActive(rulesMap[rule]),
      );
      if (res.signalCode !== null) {
        recordFailure(
          "ERR_SPAWN_TIMEOUT_KILLED",
          `--print-config ${target} killed by ${res.signalCode}`,
        );
      } else if (res.code !== EXIT_OK || cfg === null || missing.length > 0) {
        recordFailure(
          "ERR_LINT_CONFIG_DRIFT",
          `${target} (exit=${res.code}, inactive=[${missing.join(", ")}])`,
        );
      }
      return {
        target,
        exitCode: res.code,
        activeRequiredRules: `${REQUIRED_ACTIVE_RULES.length - missing.length}/${REQUIRED_ACTIVE_RULES.length}`,
      };
    }),
  );

  // Stage 4: Run --doctor audit and inspect output for unsupported/JS-hosted rules (#49393)
  const doctorRes = await runCmd(
    bunBin,
    ["lint", "--no-script", "--doctor"],
    cwd,
  );
  const doctorIssues = findDoctorUnsupportedLines(
    `${doctorRes.stdout}\n${doctorRes.stderr}`,
  );
  if (doctorRes.signalCode !== null) {
    recordFailure(
      "ERR_SPAWN_TIMEOUT_KILLED",
      `--doctor killed by ${doctorRes.signalCode}`,
    );
  } else if (doctorRes.code !== EXIT_OK || doctorIssues.length > 0) {
    recordFailure(
      "ERR_LINT_CONFIG_DRIFT",
      doctorIssues.length > 0
        ? `--doctor reported unsupported rules: ${doctorIssues.join(" | ")}`
        : `--doctor exited ${doctorRes.code}`,
    );
  }

  console.log(`=== Bun Lint Surface (${bunBin}) ===`);
  console.table(configChecks);
  console.table(explainChecks);
  console.log(`--doctor exit=${doctorRes.code} issues=${doctorIssues.length}`);
  process.exitCode = exitCode;
}

if (import.meta.main) {
  await main();
}
