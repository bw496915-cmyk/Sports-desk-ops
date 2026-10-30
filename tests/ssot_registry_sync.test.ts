import { describe, expect, test } from "bun:test";
import {
  assertSsotRegistryInSync,
  diffSsotAgainstRegistry,
} from "../lib/ssot_registry_sync.ts";
import { parseSsotTableName } from "../lib/ssot_table_name.ts";

describe("ssot_registry_sync", () => {
  test("SSOT matches sqlite_schema_registry (no drift)", () => {
    expect(diffSsotAgainstRegistry()).toEqual([]);
    expect(() => assertSsotRegistryInSync()).not.toThrow();
  });

  test("parseSsotTableName narrows known tables", () => {
    expect(parseSsotTableName("match_evaluations")).toBe("match_evaluations");
    expect(parseSsotTableName("match_evaluation")).toBeUndefined();
  });
});
