/**
 * Parse Manager `getTeaserProfile` responses (`{ LIST: [...] }`).
 * Rows tie a customer to teaser products (`TeaserName`, nested `info`).
 */

export interface TeaserProfileInfo {
  readonly teasername?: string;
  readonly TeaserTies?: number;
  readonly MaxPicks?: number;
  readonly MinPicks?: number;
  readonly Description?: string;
  readonly InternetOnlyFlag?: string;
  readonly SuspendFlag?: string;
  readonly CallUnitOnlyFlag?: string;
  readonly BaseOfferingFlag?: string;
  readonly PushNoReduce?: string;
  readonly Office?: string | null;
}

export interface TeaserProfileRow {
  readonly CustomerID?: string;
  readonly Description?: string;
  readonly TeaserName?: string;
  readonly info?: TeaserProfileInfo;
}

export interface TeaserProfileEnvelope {
  readonly LIST: TeaserProfileRow[];
}

export function trimPaddedCustomerId(raw: string | undefined): string {
  return (raw ?? "").trim();
}

export function parseTeaserProfileEnvelope(raw: unknown): TeaserProfileEnvelope {
  if (typeof raw !== "object" || raw === null)
    throw new Error("teaser profile envelope must be an object");
  const list = (raw as { LIST?: unknown }).LIST;
  if (!Array.isArray(list)) throw new Error("LIST must be an array");
  return { LIST: list as TeaserProfileRow[] };
}

export interface TeaserProfileSummary {
  readonly rowCount: number;
  readonly customerIds: string[];
  readonly teaserNames: string[];
  readonly pickRanges: Array<{ min: number | null; max: number | null }>;
}

export function summarizeTeaserProfile(
  envelope: TeaserProfileEnvelope,
): TeaserProfileSummary {
  const customerSet = new Set<string>();
  const teaserNames: string[] = [];
  const pickRanges: TeaserProfileSummary["pickRanges"] = [];
  for (const row of envelope.LIST) {
    const cid = trimPaddedCustomerId(row.CustomerID);
    if (cid) customerSet.add(cid);
    const name = trimPaddedCustomerId(row.TeaserName);
    if (name) teaserNames.push(name);
    const info = row.info;
    pickRanges.push({
      min: typeof info?.MinPicks === "number" ? info.MinPicks : null,
      max: typeof info?.MaxPicks === "number" ? info.MaxPicks : null,
    });
  }
  return {
    rowCount: envelope.LIST.length,
    customerIds: [...customerSet].sort(),
    teaserNames,
    pickRanges,
  };
}
