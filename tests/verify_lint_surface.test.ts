/**
 * @file tests/verify_lint_surface.test.ts
 * @description Unit and mock-runner contract tests for scripts/verify_lint_surface.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DOMAIN_TARGETS,
  ERROR_CODES,
  EXIT_DATAERR,
  EXIT_OK,
  EXIT_TEMPFAIL,
  EXIT_UNAVAILABLE,
  REQUIRED_ACTIVE_RULES,
  buildSanitizedEnv,
  extractCatalogRuleNames,
  inspectDoctorOutput,
  isRuleActive,
  normalizeRuleName,
  parsePrintConfigJson,
  verifyLintSurface,
  type CmdResult,
} from "../scripts/verify_lint_surface.ts";

const okResult = (stdout = "", stderr = ""): CmdResult => ({
  code: 0,
  signalCode: null,
  stdout,
  stderr,
});

describe("verify_lint_surface pure parsers", () => {
  test("normalizeRuleName maps @typescript-eslint/*, eslint/*, and bun-test/*", () => {
    expect(normalizeRuleName("@typescript-eslint/no-explicit-any")).toBe(
      "typescript/no-explicit-any",
    );
    expect(normalizeRuleName("eslint/eqeqeq")).toBe("eqeqeq");
    expect(normalizeRuleName("bun-test/prefer-snapshot-hint")).toBe(
      "bun:test/prefer-snapshot-hint",
    );
    expect(normalizeRuleName("bun/no-literal-temp-dir")).toBe(
      "bun/no-literal-temp-dir",
    );
  });

  test("extractCatalogRuleNames handles string, name/rule, and oxlint scope/value objects", () => {
    const names = extractCatalogRuleNames([
      "preserve-caught-error",
      { name: "bun/no-literal-temp-dir" },
      { rule: "@typescript-eslint/no-require-imports" },
      { scope: "eslint", value: "eqeqeq" },
      { scope: "typescript", value: "no-explicit-any" },
      { scope: "bun-test", value: "prefer-snapshot-hint" },
    ]);
    expect(names.has("preserve-caught-error")).toBe(true);
    expect(names.has("bun/no-literal-temp-dir")).toBe(true);
    expect(names.has("typescript/no-require-imports")).toBe(true);
    expect(names.has("eqeqeq")).toBe(true);
    expect(names.has("typescript/no-explicit-any")).toBe(true);
    expect(names.has("bun:test/prefer-snapshot-hint")).toBe(true);
  });

  test("isRuleActive recognizes Bun deny/warn/error/1/2 and rejects off/allow/0", () => {
    expect(isRuleActive("deny")).toBe(true);
    expect(isRuleActive("error")).toBe(true);
    expect(isRuleActive("warn")).toBe(true);
    expect(isRuleActive(2)).toBe(true);
    expect(isRuleActive(1)).toBe(true);
    expect(isRuleActive(["deny", "smart"])).toBe(true);
    expect(isRuleActive(["warn", { ignore: [0] }])).toBe(true);

    expect(isRuleActive("allow")).toBe(false);
    expect(isRuleActive("off")).toBe(false);
    expect(isRuleActive(0)).toBe(false);
    expect(isRuleActive(["off"])).toBe(false);
    expect(isRuleActive(undefined)).toBe(false);
  });

  test("parsePrintConfigJson strips trailing note lines (oven-sh/bun#47174)", () => {
    const raw = [
      "{",
      '  "rules": {',
      '    "eqeqeq": "deny"',
      "  }",
      "}",
      "note: some rules are controlled by categories",
    ].join("\n");
    const parsed = parsePrintConfigJson(raw);
    expect(parsed).toEqual({ rules: { eqeqeq: "deny" } });
    expect(parsePrintConfigJson("not json at all")).toBeNull();
  });

  test("inspectDoctorOutput flags unsupported rules and legacy ESLint bleed", () => {
    expect(inspectDoctorOutput("All 10 rules native.\n", "")).toEqual([]);
    const findings = inspectDoctorOutput(
      "Warning: 1 unsupported rule in config\nFound legacy .eslintrc.json\n",
      "",
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain("unsupported rule");
    expect(findings[1]).toContain("legacy ESLint");
  });

  test("buildSanitizedEnv strips unrelated secrets and keeps minimal POSIX keys", () => {
    const env = buildSanitizedEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/someone",
      CLOUDFLARE_API_TOKEN: "secret-should-not-leak",
    });
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "LANG",
      "NODE_ENV",
      "PATH",
      "TMPDIR",
    ]);
    expect("CLOUDFLARE_API_TOKEN" in env).toBe(false);
  });
});

describe("verifyLintSurface orchestration", () => {
  test("fails closed with ERR_OPS_BINARY_MISSING (69) when no native lint binary exists", async () => {
    const report = await verifyLintSurface({ bin: null });
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(report.failures[0]?.code).toBe("ERR_OPS_BINARY_MISSING");
  });

  test("passes all 4 stages on real repo config with mock canary runner", async () => {
    const allRepoRules = [
      ...REQUIRED_ACTIVE_RULES,
      "typescript/no-array-delete",
      "typescript/no-duplicate-type-constituents",
      "typescript/no-for-in-array",
      "typescript/no-meaningless-void-operator",
      "typescript/no-unsafe-enum-assignment",
      "typescript/no-unsafe-enum-comparison",
      "typescript/no-useless-default-assignment",
      "typescript/return-await",
      "typescript/no-base-to-string",
      "typescript/no-floating-promises",
      "typescript/restrict-template-expressions",
      "typescript/no-redundant-type-constituents",
      "typescript/require-array-sort-compare",
      "typescript/await-thenable",
      "typescript/no-misused-spread",
      "typescript/no-implied-eval",
      "typescript/unbound-method",
      "typescript/no-unsafe-unary-minus",
    ];
    const activeMap = Object.fromEntries(
      REQUIRED_ACTIVE_RULES.map((rule) => [
        rule,
        rule === "preserve-caught-error" ? "warn" : "deny",
      ]),
    );
    const seenArgs: string[][] = [];
    const report = await verifyLintSurface({
      bin: "/mock/bun-canary",
      runCmd: async (_bin, args) => {
        seenArgs.push([...args]);
        if (args.includes("--rules")) {
          return okResult(
            JSON.stringify(allRepoRules.map((name) => ({ name }))),
          );
        }
        if (args.includes("--explain")) {
          return okResult(`Rule documentation for ${args.at(-1)}`);
        }
        if (args.includes("--print-config")) {
          return okResult(
            `${JSON.stringify({ rules: activeMap })}\nnote: trailing note line`,
          );
        }
        if (args.includes("--doctor")) {
          return okResult("bun lint doctor: ok");
        }
        return okResult();
      },
    });

    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(EXIT_OK);
    expect(report.failures).toEqual([]);
    expect(report.configChecks).toHaveLength(DEFAULT_DOMAIN_TARGETS.length);
    // Every single command must pass `--no-script` immediately after `lint`.
    for (const args of seenArgs) {
      expect(args[0]).toBe("lint");
      expect(args[1]).toBe("--no-script");
    }
  });

  test("fails closed on missing domain target, inactive rule, unknown override rule, timeout, and doctor findings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-lint-surface-"));
    try {
      writeFileSync(
        join(dir, "bunfig.toml"),
        [
          "[lint.rules]",
          '"eqeqeq" = "error"',
          '"no-restricted-imports" = "error"',
          "[[lint.overrides]]",
          'files = ["a.ts"]',
          "[lint.overrides.rules]",
          '"no-restricted-imports" = "error"',
          '"made-up/unknown-rule" = "error"',
        ].join("\n"),
      );
      writeFileSync(join(dir, "present.ts"), "export const x = 1;\n");

      const report = await verifyLintSurface({
        cwd: dir,
        bin: "/mock/bun-canary",
        targets: ["present.ts", "missing.ts"],
        requiredRules: ["eqeqeq"],
        runCmd: async (_bin, args) => {
          if (args.includes("--rules")) {
            return okResult(
              JSON.stringify(["eqeqeq", "no-restricted-imports"]),
            );
          }
          if (args.includes("--explain")) {
            return { code: 1, signalCode: "SIGTERM", stdout: "", stderr: "" };
          }
          if (args.includes("--print-config")) {
            // eqeqeq disabled ("off") -> drift
            return okResult(JSON.stringify({ rules: { eqeqeq: "off" } }));
          }
          if (args.includes("--doctor")) {
            return okResult("Warning: unsupported rule found");
          }
          return okResult();
        },
      });

      expect(report.ok).toBe(false);
      expect(report.exitCode).toBe(EXIT_DATAERR);
      expect(report.warnings).toHaveLength(1);
      expect(report.warnings[0]).toContain("WARN_LINT_OVERRIDE_SHADOW");
      const codes = new Set(report.failures.map((f) => f.code));
      expect(codes.has("ERR_LINT_UNKNOWN_RULE")).toBe(true);
      expect(codes.has("ERR_SPAWN_TIMEOUT_KILLED")).toBe(true);
      expect(codes.has("ERR_LINT_CONFIG_DRIFT")).toBe(true);
      expect(codes.has("ERR_LINT_DOCTOR_UNSUPPORTED")).toBe(true);
      expect(ERROR_CODES.ERR_SPAWN_TIMEOUT_KILLED).toBe(EXIT_TEMPFAIL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
