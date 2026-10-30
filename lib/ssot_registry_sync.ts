/**
 * Runtime drift guard: compile-time SSOT must match sqlite_schema_registry DDL.
 */

import { SSOT, type SsotTableName } from "./sqlite_schema_ssot.ts";
import {
  SPORTSDESK_SQLITE_TABLES,
  type SqliteTableDef,
} from "./sqlite_schema_registry.ts";
import { listSsotTableNames } from "./ssot_table_name.ts";

export type SsotRegistryDrift = {
  table: SsotTableName | string;
  detail: string;
};

function registryBySsotKey(): Map<SsotTableName, SqliteTableDef> {
  const map = new Map<SsotTableName, SqliteTableDef>();
  for (const def of SPORTSDESK_SQLITE_TABLES) {
    const key = String(def.name) as SsotTableName;
    if (key in SSOT) map.set(key, def);
  }
  return map;
}

function nullableRegistry(nullable: boolean): "YES" | "NO" {
  return nullable ? "YES" : "NO";
}

export function diffSsotAgainstRegistry(): SsotRegistryDrift[] {
  const drifts: SsotRegistryDrift[] = [];
  const registry = registryBySsotKey();

  for (const tableName of listSsotTableNames()) {
    const spec = SSOT[tableName];
    const def = registry.get(tableName);
    if (!def) {
      drifts.push({
        table: tableName,
        detail: "missing SqliteTableDef in SPORTSDESK_SQLITE_TABLES",
      });
      continue;
    }

    const ssotCols = spec.columns;
    for (const [colName, colSpec] of Object.entries(ssotCols)) {
      const regCol = def.columns.find((c) => String(c.name) === colName);
      if (!regCol) {
        drifts.push({
          table: tableName,
          detail: `missing column "${colName}" in registry`,
        });
        continue;
      }
      if (regCol.kind !== colSpec.kind) {
        drifts.push({
          table: tableName,
          detail: `column "${colName}" kind registry=${regCol.kind} ssot=${colSpec.kind}`,
        });
      }
      if (nullableRegistry(regCol.nullable) !== colSpec.nullable) {
        drifts.push({
          table: tableName,
          detail: `column "${colName}" nullable mismatch registry=${regCol.nullable} ssot=${colSpec.nullable}`,
        });
      }
    }

    for (const col of def.columns) {
      const name = String(col.name);
      if (!(name in ssotCols)) {
        drifts.push({
          table: tableName,
          detail: `extra registry column "${name}" not in SSOT`,
        });
      }
    }

    for (const [idxKey, idxSpec] of Object.entries(spec.indexes)) {
      const idxName = String(idxSpec.name);
      const regKey = def.keys.find(
        (k) => k.kind !== "primary" && "name" in k && k.name === idxName,
      );
      if (!regKey || regKey.kind === "primary") {
        drifts.push({
          table: tableName,
          detail: `missing registry index "${idxName}" (${idxKey})`,
        });
        continue;
      }
      const regCols = regKey.columns.map((c) => String(c)).join(", ");
      const ssotCols = idxSpec.columns.join(", ");
      if (regCols !== ssotCols) {
        drifts.push({
          table: tableName,
          detail: `index "${idxName}" columns registry=[${regCols}] ssot=[${ssotCols}]`,
        });
      }
    }
  }

  for (const def of SPORTSDESK_SQLITE_TABLES) {
    const key = String(def.name);
    if (!(key in SSOT)) {
      drifts.push({
        table: key,
        detail: "registry table not present in SSOT",
      });
    }
  }

  return drifts;
}

export function assertSsotRegistryInSync(): void {
  const drifts = diffSsotAgainstRegistry();
  if (drifts.length === 0) return;
  const msg = drifts
    .map((d) => `  ${d.table}: ${d.detail}`)
    .join("\n");
  throw new Error(`SSOT/registry drift:\n${msg}`);
}
