import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { buildSqliteSchemaReportForTable } from "../lib/schema_report.ts";
import {
  decodeManifest,
  encodeManifest,
  isSqliteFileHeader,
  packJson,
  readDbHeaderBytes,
  reportToJsonWithBinary,
  sha256Bytes,
  sha256CanonicalJson,
  unpackJson,
  mergeManifests,
} from "../lib/schema_binary.ts";
import {
  COMBO_LEGS_TABLE,
  MATCH_EVALUATIONS_TABLE,
} from "../lib/sqlite_schema_registry.ts";

describe("schema_binary", () => {
  test("encodeManifest round-trips via decodeManifest", () => {
    const report = buildSqliteSchemaReportForTable(MATCH_EVALUATIONS_TABLE)!;
    const bytes = encodeManifest(report);
    const decoded = decodeManifest(bytes);
    expect(decoded.length).toBe(1);
    expect(decoded[0]?.table).toBe(MATCH_EVALUATIONS_TABLE);
    expect(
      decoded[0]?.columns.some((c) => c.column === "evaluation_json"),
    ).toBe(true);
    expect(
      decoded[0]?.columns.find((c) => c.column === "policy_sha256")?.kind,
    ).toBe("text_sha256");
  });

  test("packJson / unpackJson gzip round-trip", () => {
    const value = { policy: { ms: 10 }, legs: ["UCF+1"] };
    const packed = packJson(value, "gzip");
    expect(packed.byteLength).toBeLessThan(JSON.stringify(value).length + 50);
    expect(unpackJson(packed, "gzip")).toEqual(value);
  });

  test("sha256Bytes and sha256CanonicalJson stable", () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    expect(sha256Bytes(bytes)).toMatch(/^[a-f0-9]{64}$/);
    const a = sha256CanonicalJson({ b: 1, a: 2 });
    const b = sha256CanonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  test("reportToJsonWithBinary includes base64 manifest", () => {
    const report = buildSqliteSchemaReportForTable(MATCH_EVALUATIONS_TABLE)!;
    const json = reportToJsonWithBinary(report);
    expect(json.manifestBase64.length).toBeGreaterThan(0);
    expect(json.manifestHex.length).toBe(json.manifestByteLength * 2);
    const restored = Uint8Array.fromBase64(json.manifestBase64);
    expect(decodeManifest(restored)[0]?.table).toBe(MATCH_EVALUATIONS_TABLE);
  });

  test("readDbHeaderBytes detects SQLite magic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-bin-"));
    const dbPath = join(dir, "t.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE x (id INTEGER PRIMARY KEY)");
    db.close();
    const header = await readDbHeaderBytes(dbPath);
    expect(isSqliteFileHeader(header)).toBe(true);
  });

  test("mergeManifests concatenates chunks", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    expect([...mergeManifests([a, b])]).toEqual([1, 2, 3, 4, 5]);
  });

  test("decodeManifest rejects newer format version", () => {
    const report = buildSqliteSchemaReportForTable(MATCH_EVALUATIONS_TABLE)!;
    const bytes = encodeManifest(report);
    bytes[0] = 99;
    expect(() => decodeManifest(bytes)).toThrow(
      /manifest format v99 unsupported; upgrade decoder/,
    );
  });

  test("decodeManifest rejects unknown kind code", () => {
    const report = buildSqliteSchemaReportForTable(MATCH_EVALUATIONS_TABLE)!;
    const bytes = encodeManifest(report);
    bytes[bytes.byteLength - 2] = 42;
    expect(() => decodeManifest(bytes)).toThrow(/unknown kind code 42/);
  });

  test("integer and integer_pk use distinct kind codes", () => {
    const pkReport = buildSqliteSchemaReportForTable(MATCH_EVALUATIONS_TABLE)!;
    const pkDecoded = decodeManifest(encodeManifest(pkReport));
    expect(pkDecoded[0]?.columns.find((c) => c.column === "id")?.kind).toBe(
      "integer_pk",
    );

    const intReport = buildSqliteSchemaReportForTable(COMBO_LEGS_TABLE)!;
    const intDecoded = decodeManifest(encodeManifest(intReport));
    expect(
      intDecoded[0]?.columns.find((c) => c.column === "leg_index")?.kind,
    ).toBe("integer");
  });
});
