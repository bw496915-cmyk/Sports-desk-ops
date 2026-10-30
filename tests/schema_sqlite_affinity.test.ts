import { describe, expect, test } from "bun:test";
import {
  declaredTypeAffinity,
  manifestKindAffinityCompatible,
  requiredAffinityForManifestKind,
} from "../lib/schema_sqlite_affinity.ts";

describe("schema_sqlite_affinity", () => {
  test("declaredTypeAffinity maps common declarations", () => {
    expect(declaredTypeAffinity("INT")).toBe("INTEGER");
    expect(declaredTypeAffinity("INTEGER")).toBe("INTEGER");
    expect(declaredTypeAffinity("BOOL")).toBe("INTEGER");
    expect(declaredTypeAffinity("BOOLEAN")).toBe("INTEGER");
    expect(declaredTypeAffinity("VARCHAR(255)")).toBe("TEXT");
    expect(declaredTypeAffinity("")).toBe("BLOB");
    expect(declaredTypeAffinity("BLOB")).toBe("BLOB");
    expect(declaredTypeAffinity("REAL")).toBe("REAL");
    expect(declaredTypeAffinity("DATETIME")).toBe("NUMERIC");
    expect(declaredTypeAffinity("TIMESTAMP")).toBe("NUMERIC");
    expect(declaredTypeAffinity("NUMERIC")).toBe("NUMERIC");
  });

  test("text_iso_time requires TEXT affinity, not NUMERIC/DATETIME", () => {
    expect(requiredAffinityForManifestKind("text_iso_time")).toBe("TEXT");
    expect(manifestKindAffinityCompatible("text_iso_time", "TEXT")).toBe(true);
    expect(manifestKindAffinityCompatible("text_iso_time", "DATETIME")).toBe(
      false,
    );
    expect(manifestKindAffinityCompatible("text_iso_time", "NUMERIC")).toBe(
      false,
    );
  });

  test("integer kinds require INTEGER affinity", () => {
    expect(manifestKindAffinityCompatible("integer", "INT")).toBe(true);
    expect(manifestKindAffinityCompatible("integer", "TEXT")).toBe(false);
  });
});
