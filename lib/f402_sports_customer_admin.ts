/**
 * Parse Manager `getSportsCustomerAdmin` responses: a JSON array of
 * `{ SportType, SequenceNumber }` rows (customer-admin sports / vig lanes).
 */

export interface SportsCustomerAdminRow {
  readonly SportType?: string;
  readonly SequenceNumber?: string;
}

export function trimSportType(raw: string | undefined): string {
  return (raw ?? "").trim();
}

export function parseSportsCustomerAdminRows(
  raw: unknown,
): SportsCustomerAdminRow[] {
  if (Array.isArray(raw)) return raw as SportsCustomerAdminRow[];
  if (typeof raw === "object" && raw !== null) {
    const list = (raw as { LIST?: unknown }).LIST;
    if (Array.isArray(list)) return list as SportsCustomerAdminRow[];
    const result = (raw as { Result?: unknown }).Result;
    if (Array.isArray(result)) return result as SportsCustomerAdminRow[];
  }
  throw new Error(
    "getSportsCustomerAdmin body must be an array or { LIST | Result: [] }",
  );
}

export interface SportsCustomerAdminSummary {
  readonly rowCount: number;
  readonly sportTypeCount: number;
  readonly sportTypes: string[];
  readonly rowsBySport: Record<string, number>;
  readonly sequenceNumbers: string[];
}

export function summarizeSportsCustomerAdmin(
  rows: readonly SportsCustomerAdminRow[],
): SportsCustomerAdminSummary {
  const rowsBySport: Record<string, number> = {};
  const sequenceNumbers: string[] = [];
  for (const row of rows) {
    const sport = trimSportType(row.SportType);
    if (sport !== "") rowsBySport[sport] = (rowsBySport[sport] ?? 0) + 1;
    const seq = (row.SequenceNumber ?? "").trim();
    if (seq !== "") sequenceNumbers.push(seq);
  }
  const sportTypes = Object.keys(rowsBySport).sort();
  return {
    rowCount: rows.length,
    sportTypeCount: sportTypes.length,
    sportTypes,
    rowsBySport,
    sequenceNumbers,
  };
}

/** Map trimmed sport name → sequence numbers (for vig / sub-sport navigation). */
export function indexSequenceNumbersBySport(
  rows: readonly SportsCustomerAdminRow[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    const sport = trimSportType(row.SportType);
    const seq = (row.SequenceNumber ?? "").trim();
    if (sport === "" || seq === "") continue;
    (out[sport] ??= []).push(seq);
  }
  for (const sport of Object.keys(out)) {
    out[sport]!.sort((a, b) => Number(a) - Number(b));
  }
  return out;
}
