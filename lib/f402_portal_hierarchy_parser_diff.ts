/** Actionable diff when parser snapshot diverges from oracle (failure path only). */

export function firstOracleSnapshotLineDiff(
  parserSnapshot: string,
  oracleSnapshot: string,
): string {
  const pl = parserSnapshot.split("\n");
  const ol = oracleSnapshot.split("\n");
  for (let i = 0; i < Math.max(pl.length, ol.length); i += 1) {
    if (pl[i] !== ol[i]) {
      return `first divergent snapshot line ${i + 1}: parser=${JSON.stringify(pl[i]?.slice(0, 240))} oracle=${JSON.stringify(ol[i]?.slice(0, 240))}`;
    }
  }
  if (pl.length !== ol.length) {
    return `snapshot line count parser=${pl.length} oracle=${ol.length}`;
  }
  return "snapshots identical but sha256 differ (normalize or replacer drift)";
}
