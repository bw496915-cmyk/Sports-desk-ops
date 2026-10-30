/**
 * Registry integrity checks (optional --define SCHEMA_STRICT gate).
 */

import type { ColumnRow, KeyRow, TableSummary } from "./schema_report.ts";
import { SchemaValidationError } from "./schema_validation_error.ts";

/** Minimum shape for integrity checks (class instance or plain snapshot). */
export type SchemaReportShape = {
  readonly summary: readonly TableSummary[];
  readonly columns: readonly ColumnRow[];
  readonly keys: readonly KeyRow[];
};

export type SchemaValidationIssue = {
  code: string;
  message: string;
  table?: string;
  keyName?: string;
  column?: string;
};

export function validateSchemaReport(
  report: SchemaReportShape,
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  const tableNames = new Set<string>(
    report.summary.map((s) => String(s.table)),
  );

  for (const name of tableNames) {
    if (!report.columns.some((c) => c.table === name)) {
      issues.push({
        code: "empty_columns",
        message: `summary lists table "${name}" with no column rows`,
      });
    }
  }

  for (const col of report.columns) {
    if (!tableNames.has(String(col.table))) {
      issues.push({
        code: "orphan_column",
        message: `column "${col.column}" references unknown table "${col.table}"`,
      });
    }
  }

  const columnsByTable = new Map<string, Set<string>>();
  for (const col of report.columns) {
    let set = columnsByTable.get(col.table);
    if (!set) {
      set = new Set();
      columnsByTable.set(col.table, set);
    }
    set.add(col.column);
  }

  for (const key of report.keys) {
    const cols = columnsByTable.get(key.table);
    if (!cols) {
      issues.push({
        code: "orphan_key",
        message: `key "${key.name}" on unknown table "${key.table}"`,
      });
      continue;
    }
    for (const part of key.columns.split(",").map((s) => s.trim())) {
      if (!part) continue;
      if (!cols.has(part)) {
        issues.push({
          code: "key_unknown_column",
          message: `key "${key.name}" on "${key.table}" references missing column "${part}"`,
          table: key.table,
          keyName: key.name,
          column: part,
        });
      }
    }
    if (key.partial.includes("?")) {
      issues.push({
        code: "partial_placeholder",
        message: `key "${key.name}" has unresolved partial predicate`,
      });
    }
  }

  return issues;
}

export function assertSchemaReportValid(report: SchemaReportShape): void {
  const issues = validateSchemaReport(report);
  if (issues.length === 0) return;
  const msg = issues.map((i) => `${i.code}: ${i.message}`).join("\n");
  throw new SchemaValidationError(`schema registry invalid:\n${msg}`, issues);
}
