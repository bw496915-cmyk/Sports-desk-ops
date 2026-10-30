/**
 * Declared-type → SQLite type affinity (not per-row storage class).
 *
 * Parity asserts declared-type affinity compatibility, not per-row storage class.
 * A NUMERIC-affinity column may store TEXT, INTEGER, or REAL per row; strict
 * value-class verification requires typeof sampling and is out of scope here.
 */

import type { SqliteStorageKind } from "./sqlite_schema_registry.ts";

export type SqliteTypeAffinity =
  "INTEGER" | "TEXT" | "REAL" | "BLOB" | "NUMERIC";

/** Affinity SQLite assigns from a column's declared type name. */
export function declaredTypeAffinity(declared: string): SqliteTypeAffinity {
  const u = (declared ?? "").trim().toUpperCase();
  if (u === "") return "BLOB";

  const head = u.split("(")[0]!.trim();

  if (head.includes("INT") || head === "BOOL" || head === "BOOLEAN") {
    return "INTEGER";
  }
  if (head.includes("CHAR") || head.includes("CLOB") || head.includes("TEXT")) {
    return "TEXT";
  }
  if (head.includes("BLOB")) return "BLOB";
  if (head.includes("REAL") || head.includes("FLOA") || head.includes("DOUB")) {
    return "REAL";
  }
  if (
    head.includes("NUMERIC") ||
    head.includes("DECIMAL") ||
    head.includes("DATETIME") ||
    head.includes("TIMESTAMP")
  ) {
    return "NUMERIC";
  }

  return "NUMERIC";
}

/** Manifest semantic kinds map to a single required declared affinity. */
export function requiredAffinityForManifestKind(
  kind: SqliteStorageKind,
): SqliteTypeAffinity {
  if (kind === "integer_pk" || kind === "integer") return "INTEGER";
  if (kind === "real") return "REAL";
  return "TEXT";
}

export function manifestKindAffinityCompatible(
  kind: SqliteStorageKind,
  declaredType: string,
): boolean {
  const required = requiredAffinityForManifestKind(kind);
  const prod = declaredTypeAffinity(declaredType);
  return required === prod;
}

export function affinityMismatchMessage(
  table: string,
  column: string,
  kind: SqliteStorageKind,
  declaredType: string,
): string {
  const required = requiredAffinityForManifestKind(kind);
  const prod = declaredTypeAffinity(declaredType);
  return `affinity drift ${table}.${column}: manifest kind ${kind} requires ${required} affinity vs declared ${declaredType || "(empty)"} (${prod})`;
}
