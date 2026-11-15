import { describe, expect, test } from "bun:test";
import { CodeModeRunner } from "./code_mode.ts";
import {
  PROFILE_CODE_MODE_TOOL_NAMES,
  registerProfileQueryCodeModeTools,
} from "./profile_query_codemode.ts";

describe("profile_query codemode", () => {
  test("registers expected tool names and appears in type declarations", () => {
    const runner = new CodeModeRunner();
    registerProfileQueryCodeModeTools(runner);
    const dts = runner.generateTypeDeclarations();
    for (const name of PROFILE_CODE_MODE_TOOL_NAMES) {
      expect(runner.getTool(name)?.name).toBe(name);
      expect(dts).toContain(`${name}(`);
    }
  });

  test("zod rejects non-literal includeSentinels", async () => {
    const runner = new CodeModeRunner();
    registerProfileQueryCodeModeTools(runner);
    const script = `
      const r = await tools.query_profiles({
        field: "clv",
        includeSentinels: "yes",
      });
      return r.rows.some((row) => row.sentinel);
    `;
    const result = await runner.execute(script);
    expect(result.success).toBe(false);
  });
});
