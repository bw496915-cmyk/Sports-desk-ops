import { SPORTSDESK_SQLITE_TABLES } from "./sqlite_schema_registry.ts";
import { buildSqliteSchemaReport } from "./schema_report.ts";

/** Full registry report — import this module (not `sqlite_schema_registry`) to avoid cycles. */
export const sportsdeskSqliteSchemaReport = buildSqliteSchemaReport(
  SPORTSDESK_SQLITE_TABLES,
);
