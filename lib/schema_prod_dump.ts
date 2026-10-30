/**
 * Versioned PRAGMA snapshot for offline manifest parity (no row data).
 *
 * captured_at is the observation time, not the commit time; preserve it verbatim
 * on re-commit (only schema:dump-prod / re-capture should change it).
 */

import type { Database } from "bun:sqlite";
import { openSportsdeskSqliteReadonly, sqlInt } from "./sportsdesk_sqlite.ts";
import {
  buildSqliteSchemaReport,
  listRegisteredTableNames,
} from "./schema_report.ts";

export const PROD_SCHEMA_DUMP_FORMAT_VERSION = 1;
export const SUPPORTED_PROD_SCHEMA_DUMP_VERSION =
  PROD_SCHEMA_DUMP_FORMAT_VERSION;

export type ProdSchemaDumpColumn = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  hidden: number;
};

export type ProdSchemaDumpAllowlistEntry = {
  reason: string;
  review_by: string | null;
};

export type ProdSchemaDump = {
  format_version: number;
  /** Observation time from capture; not updated on git re-commit alone. */
  captured_at: string;
  /** Reviewer-trusted label (e.g. prod-readonly); not cryptographic proof of origin. */
  source: string;
  tables: Record<string, ProdSchemaDumpColumn[]>;
  allowlist?: Record<string, ProdSchemaDumpAllowlistEntry>;
};

export const SQLITE_INTERNAL_TABLES = new Set([
  "sqlite_sequence",
  "sqlite_stat1",
  "sqlite_stat4",
  "sqlite_master",
  "sqlite_schema",
  "sqlite_temp_master",
]);

export function quoteSqliteIdent(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) {
    throw new Error(`unsafe sqlite identifier: ${name}`);
  }
  return `"${name}"`;
}

type XInfoRawRow = Omit<ProdSchemaDumpColumn, "notnull" | "pk" | "hidden"> & {
  notnull: number | bigint;
  pk: number | bigint;
  hidden: number | bigint;
};

/** Generated/stored columns (hidden 2/3); exclude rowid aliases (hidden 1). */
export function filterVisibleXInfoColumns(
  rows: XInfoRawRow[],
): ProdSchemaDumpColumn[] {
  return rows
    .filter((c) => {
      const hidden = sqlInt(c.hidden);
      return hidden === 0 || hidden >= 2;
    })
    .map((c) => ({
      name: c.name,
      type: c.type,
      notnull: sqlInt(c.notnull),
      pk: sqlInt(c.pk),
      hidden: sqlInt(c.hidden),
    }));
}

export function readTableColumnsXInfo(
  db: Database,
  table: string,
): ProdSchemaDumpColumn[] {
  const rows = db
    .query(`PRAGMA table_xinfo(${quoteSqliteIdent(table)})`)
    .all() as XInfoRawRow[];
  return filterVisibleXInfoColumns(rows);
}

export function listUserTables(db: Database): string[] {
  const rows = db
    .query(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as { name: string }[];
  return rows
    .map((r) => r.name)
    .filter(
      (name) =>
        !name.startsWith("sqlite_") && !SQLITE_INTERNAL_TABLES.has(name),
    );
}

export function parseProdSchemaDumpAllowlist(
  raw: unknown,
): Record<string, ProdSchemaDumpAllowlistEntry> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object") {
    throw new Error("prod schema dump: allowlist must be an object");
  }
  const out: Record<string, ProdSchemaDumpAllowlistEntry> = {};
  for (const [table, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`prod schema dump: allowlist.${table} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.reason !== "string" || !e.reason.trim()) {
      throw new Error(`prod schema dump: allowlist.${table}.reason required`);
    }
    if (
      e.review_by !== null &&
      (typeof e.review_by !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(e.review_by))
    ) {
      throw new Error(
        `prod schema dump: allowlist.${table}.review_by must be YYYY-MM-DD or null`,
      );
    }
    out[table] = {
      reason: e.reason.trim(),
      review_by: e.review_by as string | null,
    };
  }
  return out;
}

export function prodDumpAllowlistedTableNames(
  dump: ProdSchemaDump,
): Set<string> {
  if (!dump.allowlist) return new Set();
  return new Set(Object.keys(dump.allowlist));
}

/** State-based allowlist hygiene (table dropped or promoted into registry). */
export function allowlistRotWarnings(
  dump: ProdSchemaDump,
  manifestTableNames: ReadonlySet<string>,
): string[] {
  if (!dump.allowlist) return [];
  const captured = new Set(Object.keys(dump.tables));
  const warnings: string[] = [];
  for (const table of Object.keys(dump.allowlist)) {
    if (manifestTableNames.has(table)) {
      warnings.push(
        `allowlist entry "${table}" is now in the registry; remove from allowlist`,
      );
    } else if (!captured.has(table)) {
      warnings.push(
        `allowlist entry "${table}" is not present in captured tables; orphaned`,
      );
    }
  }
  return warnings;
}

export function staleAllowlistWarnings(
  dump: ProdSchemaDump,
  todayUtc = new Date().toISOString().slice(0, 10),
): string[] {
  if (!dump.allowlist) return [];
  const warnings: string[] = [];
  for (const [table, entry] of Object.entries(dump.allowlist)) {
    if (entry.review_by && entry.review_by < todayUtc) {
      warnings.push(
        `[STALE] allowlist entry "${table}" past review_by ${entry.review_by}; remove from fixture (${entry.reason})`,
      );
    }
  }
  return warnings;
}

export function captureProdSchemaFromDb(
  dbPath: string,
  sourceLabel: string,
  preserve?: Pick<ProdSchemaDump, "allowlist" | "captured_at">,
): ProdSchemaDump {
  const db = openSportsdeskSqliteReadonly(dbPath);
  try {
    const tableNames = listUserTables(db);
    const tables: Record<string, ProdSchemaDumpColumn[]> = {};
    for (const name of tableNames) {
      tables[name] = readTableColumnsXInfo(db, name);
    }
    return {
      format_version: PROD_SCHEMA_DUMP_FORMAT_VERSION,
      captured_at: preserve?.captured_at ?? new Date().toISOString(),
      source: sourceLabel,
      tables,
      ...(preserve?.allowlist ? { allowlist: preserve.allowlist } : {}),
    };
  } finally {
    db.close();
  }
}

export function parseProdSchemaDump(json: unknown): ProdSchemaDump {
  if (json === null || typeof json !== "object") {
    throw new Error("prod schema dump: expected object");
  }
  const o = json as Record<string, unknown>;
  const version = o.format_version;
  if (typeof version !== "number") {
    throw new Error("prod schema dump: missing format_version");
  }
  if (version > SUPPORTED_PROD_SCHEMA_DUMP_VERSION) {
    throw new Error(
      `prod schema dump format v${version} unsupported; upgrade parity code (supported v${SUPPORTED_PROD_SCHEMA_DUMP_VERSION})`,
    );
  }
  if (version < SUPPORTED_PROD_SCHEMA_DUMP_VERSION) {
    throw new Error(
      `prod schema dump format v${version} obsolete; re-run schema:dump-prod`,
    );
  }
  if (typeof o.captured_at !== "string" || typeof o.source !== "string") {
    throw new Error("prod schema dump: missing captured_at or source");
  }
  if (o.tables === null || typeof o.tables !== "object") {
    throw new Error("prod schema dump: missing tables");
  }
  const allowlist = parseProdSchemaDumpAllowlist(o.allowlist);
  return {
    format_version: version,
    captured_at: o.captured_at,
    source: o.source,
    tables: o.tables as Record<string, ProdSchemaDumpColumn[]>,
    ...(allowlist !== undefined ? { allowlist } : {}),
  };
}

export async function loadProdSchemaDump(
  path: string,
): Promise<ProdSchemaDump> {
  const text = await Bun.file(path).text();
  return parseProdSchemaDump(JSON.parse(text));
}

/** Registry-shaped PRAGMA baseline for CI when prod is unavailable. */
export function buildRegistryBaselineProdDump(
  source = "registry-baseline",
): ProdSchemaDump {
  const report = buildSqliteSchemaReport();
  const tables: Record<string, ProdSchemaDumpColumn[]> = {};

  for (const summary of report.summary) {
    const cols = report.columns.filter((c) => c.table === summary.table);
    tables[summary.table] = cols.map((c) => {
      const isPk =
        c.keyRoles === "PK" ||
        c.keyRoles.startsWith("PK,") ||
        c.keyRoles.includes(",PK,") ||
        c.keyRoles.endsWith(",PK");
      const integerPk = c.kind === "integer_pk";
      return {
        name: c.column,
        type: c.sqlType,
        notnull: integerPk && isPk ? 0 : c.nullable === "YES" ? 0 : 1,
        pk: isPk ? 1 : 0,
        hidden: 0,
      };
    });
  }

  return {
    format_version: PROD_SCHEMA_DUMP_FORMAT_VERSION,
    captured_at: new Date().toISOString(),
    source,
    tables,
    allowlist: {},
  };
}

export function registeredTableNamesSet(): Set<string> {
  return new Set(listRegisteredTableNames());
}
