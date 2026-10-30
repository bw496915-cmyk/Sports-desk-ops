/**
 * Release drill: parity must report combined diagnostics and exit by max severity.
 */

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import type { DecodedManifestTable } from "./schema_binary.ts";
import {
  SCHEMA_DUMP_PARITY_POLICY_EXIT,
  SCHEMA_DUMP_PARITY_STRUCTURAL_EXIT,
  collectManifestDumpParityDiagnostics,
  exitCodeFromParityDiagnostics,
  runManifestDumpParity,
} from "./schema_manifest_db_parity.ts";
import {
  captureProdSchemaFromDb,
  type ProdSchemaDump,
} from "./schema_prod_dump.ts";

export type GauntletScenarioResult = {
  name: string;
  expectedExit: number;
  actualExit: number;
  ok: boolean;
  messageSample: string;
};

function captureFromSql(tableSql: Record<string, string>): ProdSchemaDump {
  const dir = mkdtempSync(join(tmpdir(), "parity-gauntlet-"));
  const dbPath = join(dir, "t.sqlite");
  const db = openSportsdeskSqlite(dbPath);
  for (const sql of Object.values(tableSql)) {
    db.exec(sql);
  }
  db.close();
  return captureProdSchemaFromDb(dbPath, "parity-gauntlet");
}

function scenarioStructuralExit2(): GauntletScenarioResult {
  const manifest: DecodedManifestTable[] = [
    {
      table: "ingestion_trades",
      columns: [
        { column: "id", kind: "integer_pk", nullable: false },
        { column: "qty", kind: "integer", nullable: true },
      ],
    },
  ];
  const dump = captureFromSql({
    ingestion_trades: `
      CREATE TABLE ingestion_trades (
        id INTEGER PRIMARY KEY,
        qty INTEGER NOT NULL
      );
    `,
  });
  const actualExit = runManifestDumpParity(dump, manifest, {
    strictProdOnlyTables: false,
    strictStaleAllowlist: true,
  });
  const diagnostics = collectManifestDumpParityDiagnostics(dump, manifest, {
    strictProdOnlyTables: false,
    strictStaleAllowlist: true,
  });
  return {
    name: "structural_nullability",
    expectedExit: SCHEMA_DUMP_PARITY_STRUCTURAL_EXIT,
    actualExit,
    ok: actualExit === SCHEMA_DUMP_PARITY_STRUCTURAL_EXIT,
    messageSample: diagnostics.find((d) => d.severity === 2)?.message ?? "",
  };
}

function scenarioCombinedExit3(): GauntletScenarioResult {
  const manifest: DecodedManifestTable[] = [
    {
      table: "ingestion_trades",
      columns: [{ column: "price", kind: "real", nullable: false }],
    },
  ];
  const dump = captureFromSql({
    ingestion_trades: `CREATE TABLE ingestion_trades (price REAL);`,
  });
  dump.allowlist = {
    orphan_hotfix: {
      reason: "gauntlet stale entry",
      review_by: "2020-01-01",
    },
  };
  dump.tables.orphan_hotfix = [
    { name: "x", type: "TEXT", notnull: 0, pk: 0, hidden: 0 },
  ];

  const actualExit = runManifestDumpParity(dump, manifest, {
    strictProdOnlyTables: true,
    strictStaleAllowlist: true,
  });
  const diagnostics = collectManifestDumpParityDiagnostics(dump, manifest, {
    strictProdOnlyTables: true,
    strictStaleAllowlist: true,
  });
  const messages = diagnostics.map((d) => d.message).join("\n");
  const hasStale = /STALE.*orphan_hotfix/.test(messages);
  const hasStructural = diagnostics.some((d) => d.severity === 2);
  const exitOk = actualExit === SCHEMA_DUMP_PARITY_POLICY_EXIT;
  return {
    name: "stale_allowlist_plus_structural",
    expectedExit: SCHEMA_DUMP_PARITY_POLICY_EXIT,
    actualExit,
    ok: exitOk && hasStale && hasStructural,
    messageSample: messages.slice(0, 240),
  };
}

export function runSchemaParityGauntlet(): GauntletScenarioResult[] {
  return [scenarioStructuralExit2(), scenarioCombinedExit3()];
}

export function schemaParityGauntletOk(results: GauntletScenarioResult[]): boolean {
  return results.every((r) => r.ok);
}
