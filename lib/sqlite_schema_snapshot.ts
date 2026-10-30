/**
 * Persist schema binary manifests via Bun.write(string | URL, data).
 */

import { encodeManifest } from "./schema_binary.ts";
import type { SqliteSchemaReport } from "./schema_report.ts";
import type { SchemaValidationIssue } from "./schema_validate.ts";

export async function emitSnapshot(
  report: SqliteSchemaReport,
  outUrl: URL,
): Promise<URL> {
  const bytes = encodeManifest(report);
  await Bun.write(outUrl, bytes);
  return outUrl;
}

export type SchemaReportJsonDocument = {
  summary: Array<{
    table: string;
    domain: string;
    columns: number;
    keys: number;
    appendOnly: string;
    docsUrl: string;
  }>;
  columns: SqliteSchemaReport["columns"];
  keys: SqliteSchemaReport["keys"];
  databaseUrl: string;
  sourceUrl: string;
  manifestUrl: string;
  generatedAt: string;
  validationIssues?: SchemaValidationIssue[];
  db?: {
    path: string;
    headerBytes: number;
    sqliteMagicOk: true;
  };
};

export function schemaReportJsonDocument(
  report: SqliteSchemaReport,
  manifestUrl: URL,
  extras?: {
    validationIssues?: SchemaValidationIssue[];
    db?: SchemaReportJsonDocument["db"];
  },
): SchemaReportJsonDocument {
  const doc: SchemaReportJsonDocument = {
    summary: report.summary.map((t) => ({
      table: t.table,
      domain: t.domain,
      columns: t.columns,
      keys: t.keys,
      appendOnly: t.appendOnly,
      docsUrl: t.docsUrl.href,
    })),
    columns: report.columns,
    keys: report.keys,
    databaseUrl: report.databaseUrl.href,
    sourceUrl: report.sourceUrl.href,
    manifestUrl: manifestUrl.href,
    generatedAt: report.generatedAt,
  };
  if (
    extras?.validationIssues !== undefined &&
    extras.validationIssues.length > 0
  ) {
    doc.validationIssues = extras.validationIssues;
  }
  if (extras?.db !== undefined) {
    doc.db = extras.db;
  }
  return doc;
}
