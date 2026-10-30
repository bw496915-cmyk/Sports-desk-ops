import { describe, expect, test } from "bun:test";
import { buildSqliteSchemaReport } from "../lib/schema_report.ts";
import { validateSchemaReport } from "../lib/schema_validate.ts";

describe("schema_validate", () => {
  test("production registry passes validation", () => {
    const report = buildSqliteSchemaReport();
    expect(validateSchemaReport(report)).toEqual([]);
  });

  test("detects key referencing missing column", () => {
    const report = buildSqliteSchemaReport();
    const broken = {
      ...report,
      keys: [
        ...report.keys,
        {
          table: "match_evaluations",
          keyKind: "index" as const,
          name: "bad_idx",
          columns: "not_a_real_column",
          partial: "",
        },
      ],
    };
    const issues = validateSchemaReport(broken);
    expect(issues.some((i) => i.code === "key_unknown_column")).toBe(true);
  });
});
