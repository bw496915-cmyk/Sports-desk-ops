import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditBunfigLintRules,
  DOMAIN_TARGETS,
  EXIT_UNAVAILABLE,
  findDoctorUnsupportedLines,
  isRuleActive,
  parsePrintConfigJson,
  REQUIRED_ACTIVE_RULES,
} from "../scripts/verify_lint_surface.ts";

const ROOT = resolve(import.meta.dir, "..");

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
