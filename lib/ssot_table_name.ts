import { SSOT, type SsotTableName } from "./sqlite_schema_ssot.ts";

export type { SsotTableName };

export function listSsotTableNames(): readonly SsotTableName[] {
  return Object.keys(SSOT) as SsotTableName[];
}

export function parseSsotTableName(raw: string): SsotTableName | undefined {
  const name = raw.trim();
  if (name in SSOT) return name as SsotTableName;
  return undefined;
}

export function isSsotTableName(name: string): name is SsotTableName {
  return parseSsotTableName(name) !== undefined;
}
