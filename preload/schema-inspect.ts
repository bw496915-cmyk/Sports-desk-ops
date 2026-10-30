/**
 * Registry preload for ad-hoc probes (`bun --preload ./preload/schema-inspect.ts …`).
 *
 * Builds `SqliteSchemaReport`, which implements `[Bun.inspect.custom]` (box tables
 * via lib/inspect.ts). One-liners pretty-print the full registry without running the CLI:
 *
 *   bun --preload ./preload/schema-inspect.ts -p 'console.log(__schemaReport)'
 *   bun run schema:inspect
 *
 * Stdin REPL (preload must be on `run`, not before it, on Bun 1.4.4):
 *   bun run --preload ./preload/schema-inspect.ts -
 *   # then: console.log(__schemaReport)
 */

import { buildSqliteSchemaReport } from "../lib/schema_report.ts";
import { inspectColumns, inspectKeys, inspectSummary } from "../lib/inspect.ts";

const report = buildSqliteSchemaReport();

declare global {
  // eslint-disable-next-line no-var
  var __schemaReport: typeof report;
  // eslint-disable-next-line no-var
  var __schemaInspect: {
    summary: typeof inspectSummary;
    columns: typeof inspectColumns;
    keys: typeof inspectKeys;
  };
}

globalThis.__schemaReport = report;
globalThis.__schemaInspect = {
  summary: inspectSummary,
  columns: inspectColumns,
  keys: inspectKeys,
};
