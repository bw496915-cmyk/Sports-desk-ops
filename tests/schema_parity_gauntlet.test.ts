import { describe, expect, test } from "bun:test";
import {
  runSchemaParityGauntlet,
  schemaParityGauntletOk,
} from "../lib/schema_parity_gauntlet.ts";
import {
  SCHEMA_DUMP_PARITY_POLICY_EXIT,
  SCHEMA_DUMP_PARITY_STRUCTURAL_EXIT,
} from "../lib/schema_manifest_db_parity.ts";

describe("schema_parity_gauntlet", () => {
  test("drill scenarios match expected exit codes", () => {
    const results = runSchemaParityGauntlet();
    expect(schemaParityGauntletOk(results)).toBe(true);
    const structural = results.find((r) => r.name === "structural_nullability");
    const combined = results.find(
      (r) => r.name === "stale_allowlist_plus_structural",
    );
    expect(structural?.actualExit).toBe(SCHEMA_DUMP_PARITY_STRUCTURAL_EXIT);
    expect(combined?.actualExit).toBe(SCHEMA_DUMP_PARITY_POLICY_EXIT);
  });
});
