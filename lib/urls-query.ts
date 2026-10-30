import type { SsotTableName } from "./sqlite_schema_ssot.ts";
import { parseSsotTableName } from "./ssot_table_name.ts";

export type TableParam<P extends string> = P extends `${string}table=${infer T}${"&" | ""}${string}`
  ? T extends SsotTableName
    ? T
    : never
  : never;

export function parseTableParam<const P extends string>(
  search: P,
): TableParam<P> | undefined {
  const q = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const t = q.get("table");
  if (t === null) return undefined;
  const parsed = parseSsotTableName(t);
  return parsed as TableParam<P> | undefined;
}

export function parseTableParamFromUrl(url: string | URL): SsotTableName | undefined {
  const u = typeof url === "string" ? new URL(url) : url;
  return parseTableParam(u.search.slice(1) as `${string}table=${string}`);
}
