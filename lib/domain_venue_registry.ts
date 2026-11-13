// Domain, writer-lane, and venue registry (canonical single source of truth).
// Complies with the Naming Constitution (no generation tags, no banned abbreviations)
// and zero heap-collection lookups in hot resolution paths.

/** Canonical upstream origin domain identifiers across all sportsdesk bridges. */
export type OriginDomainId =
  | "ORIGIN_SPORTSBOOK_FANTASY402"
  | "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118"
  | "ORIGIN_EXCHANGE_POLYMARKET_CTF"
  | "ORIGIN_EXCHANGE_KALSHI_REGULATED"
  | "ORIGIN_STORAGE_R2_LAKEHOUSE"
  | "ORIGIN_HOST_NSH_DESK_LOCAL";

/** Canonical venue identifiers unifying legacy ComboVenue and Venue unions. */
export type VenueId =
  "f402" | "gslive_partner118" | "polymarket" | "kalshi" | "internal";

/** Canonical writer lane identifiers matching ingestion token provenance. */
export type WriterLaneId =
  | "inet"
  | "gateway"
  | "gsbuilder"
  | "gslive"
  | "cslevel2"
  | "alert"
  | "blocked"
  | "unknown";

export type OriginDomainEntry = {
  readonly originDomainId: OriginDomainId;
  readonly venueId: VenueId;
  readonly displayLabel: string;
  readonly brandColorHex: string;
  readonly defaultTokenCode: string;
};

export type WriterLaneEntry = {
  readonly writerLaneId: WriterLaneId;
  readonly originDomainId: OriginDomainId;
  readonly venueId: VenueId;
  readonly tokenProvenanceCode: string;
  readonly provenanceLabel: string;
  readonly brandColorHex: string;
};

export const ORIGIN_DOMAIN_REGISTRY: Readonly<
  Record<OriginDomainId, OriginDomainEntry>
> = {
  ORIGIN_SPORTSBOOK_FANTASY402: {
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    venueId: "f402",
    displayLabel: "Fantasy402 Agent Portal",
    brandColorHex: "#1d84b5",
    defaultTokenCode: "L18_N0204",
  },
  ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118: {
    originDomainId: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    venueId: "gslive_partner118",
    displayLabel: "Partner 118 GSLive Book",
    brandColorHex: "#28a745",
    defaultTokenCode: "L23_N0412",
  },
  ORIGIN_EXCHANGE_POLYMARKET_CTF: {
    originDomainId: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    venueId: "polymarket",
    displayLabel: "Polymarket CTF Exchange",
    brandColorHex: "#38bdf8",
    defaultTokenCode: "L24_N2019",
  },
  ORIGIN_EXCHANGE_KALSHI_REGULATED: {
    originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
    venueId: "kalshi",
    displayLabel: "Kalshi Regulated Exchange",
    brandColorHex: "#10b981",
    defaultTokenCode: "L20_N1105",
  },
  ORIGIN_STORAGE_R2_LAKEHOUSE: {
    originDomainId: "ORIGIN_STORAGE_R2_LAKEHOUSE",
    venueId: "internal",
    displayLabel: "Cloudflare R2 Lakehouse",
    brandColorHex: "#f59e0b",
    defaultTokenCode: "L22_N1402",
  },
  ORIGIN_HOST_NSH_DESK_LOCAL: {
    originDomainId: "ORIGIN_HOST_NSH_DESK_LOCAL",
    venueId: "internal",
    displayLabel: "Desk Host Local",
    brandColorHex: "#64748b",
    defaultTokenCode: "L19_N0518",
  },
};

export const WRITER_LANE_REGISTRY: Readonly<
  Record<WriterLaneId, WriterLaneEntry>
> = {
  inet: {
    writerLaneId: "inet",
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    venueId: "f402",
    tokenProvenanceCode: "L18_N0204",
    provenanceLabel: "Internet",
    brandColorHex: "#1d84b5",
  },
  gateway: {
    writerLaneId: "gateway",
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    venueId: "f402",
    tokenProvenanceCode: "L20_N1105",
    provenanceLabel: "GATEWAY",
    brandColorHex: "#10b981",
  },
  gsbuilder: {
    writerLaneId: "gsbuilder",
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    venueId: "f402",
    tokenProvenanceCode: "L22_N1402",
    provenanceLabel: "GSBUILDER",
    brandColorHex: "#f59e0b",
  },
  gslive: {
    writerLaneId: "gslive",
    originDomainId: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    venueId: "gslive_partner118",
    tokenProvenanceCode: "L23_N0412",
    provenanceLabel: "GSLIVE",
    brandColorHex: "#28a745",
  },
  cslevel2: {
    writerLaneId: "cslevel2",
    originDomainId: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    venueId: "polymarket",
    tokenProvenanceCode: "L24_N2019",
    provenanceLabel: "CSLEVEL2",
    brandColorHex: "#38bdf8",
  },
  alert: {
    writerLaneId: "alert",
    originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
    venueId: "kalshi",
    tokenProvenanceCode: "L21_N0884",
    provenanceLabel: "ALERT",
    brandColorHex: "#ef4444",
  },
  blocked: {
    writerLaneId: "blocked",
    originDomainId: "ORIGIN_HOST_NSH_DESK_LOCAL",
    venueId: "internal",
    tokenProvenanceCode: "L19_N0518",
    provenanceLabel: "BLOCKED",
    brandColorHex: "#64748b",
  },
  unknown: {
    writerLaneId: "unknown",
    originDomainId: "ORIGIN_HOST_NSH_DESK_LOCAL",
    venueId: "internal",
    tokenProvenanceCode: "L19_N0518",
    // NOT "BLOCKED": an unparseable writer label is unresolved, and calling it
    // blocked makes a parsing gap look like a compliance decision.
    provenanceLabel: "UNRESOLVED",
    brandColorHex: "#94a3b8",
  },
};

/**
 * What kind of book a venue is. The maths differs: a sportsbook holds the stake
 * (its liability is the payout), an exchange matches two sides (its exposure is
 * the position), and internal venues settle nothing at all.
 */
export type VenueKind = "sportsbook" | "exchange" | "internal";

export type VenueEntry = {
  readonly venueId: VenueId;
  readonly displayLabel: string;
  readonly kind: VenueKind;
  readonly brandColorHex: string;
  /** Every origin domain that resolves to this venue. Checked by the test suite. */
  readonly originDomainIds: readonly OriginDomainId[];
};

/**
 * The venue level the other two registries point at.
 *
 * ORIGIN_DOMAIN_REGISTRY says where a token came from and WRITER_LANE_REGISTRY
 * says which lane wrote it; neither answers "is this an exchange or a book?",
 * which is the question the risk maths depends on.
 */
export const VENUE_REGISTRY: Readonly<Record<VenueId, VenueEntry>> = {
  f402: {
    venueId: "f402",
    displayLabel: "Fantasy402",
    kind: "sportsbook",
    brandColorHex: "#1d84b5",
    originDomainIds: ["ORIGIN_SPORTSBOOK_FANTASY402"],
  },
  gslive_partner118: {
    venueId: "gslive_partner118",
    displayLabel: "GSLive Partner 118",
    kind: "sportsbook",
    brandColorHex: "#28a745",
    originDomainIds: ["ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118"],
  },
  polymarket: {
    venueId: "polymarket",
    displayLabel: "Polymarket",
    kind: "exchange",
    brandColorHex: "#38bdf8",
    originDomainIds: ["ORIGIN_EXCHANGE_POLYMARKET_CTF"],
  },
  kalshi: {
    venueId: "kalshi",
    displayLabel: "Kalshi",
    kind: "exchange",
    brandColorHex: "#10b981",
    originDomainIds: ["ORIGIN_EXCHANGE_KALSHI_REGULATED"],
  },
  internal: {
    venueId: "internal",
    displayLabel: "Desk Internal",
    kind: "internal",
    brandColorHex: "#f59e0b",
    originDomainIds: ["ORIGIN_STORAGE_R2_LAKEHOUSE", "ORIGIN_HOST_NSH_DESK_LOCAL"],
  },
};

// NAMING-GATE-04: no Map/Set allocation on a resolution path. Ownership
// lookups run against the frozen records themselves, which allocates nothing.
export function isVenueId(value: unknown): value is VenueId {
  return typeof value === "string" && Object.hasOwn(VENUE_REGISTRY, value);
}

export function isOriginDomainId(value: unknown): value is OriginDomainId {
  return typeof value === "string" && Object.hasOwn(ORIGIN_DOMAIN_REGISTRY, value);
}

export function isWriterLaneId(value: unknown): value is WriterLaneId {
  return typeof value === "string" && Object.hasOwn(WRITER_LANE_REGISTRY, value);
}

/**
 * Parse a venue token arriving from outside the process (JSON, a CLI flag, an
 * env var). Returns null instead of guessing: a caller that gets null must
 * decide whether to reject the row or record it as unresolved, and those are
 * different decisions.
 *
 * This is the strict counterpart of resolveWriterLaneId, which is deliberately
 * forgiving about raw writer spellings.
 */
export function parseVenueId(raw: unknown): VenueId | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (Object.hasOwn(VENUE_REGISTRY, token)) return token as VenueId;
  const alias: Readonly<Record<string, VenueId>> = {
    fantasy402: "f402",
    gslive: "gslive_partner118",
    gs_live: "gslive_partner118",
    partner118: "gslive_partner118",
    partner_118: "gslive_partner118",
    poly: "polymarket",
    ctf: "polymarket",
    desk: "internal",
    host: "internal",
  };
  return alias[token] ?? null;
}

/** Total lookup: a VenueId always has an entry because the Record is exhaustive. */
export function venueEntry(venueId: VenueId): VenueEntry {
  return VENUE_REGISTRY[venueId];
}

/** One step from a raw writer label to the venue it traded on. */
export function resolveVenueIdForWriter(rawWriter: string): VenueId {
  return WRITER_LANE_REGISTRY[resolveWriterLaneId(rawWriter)].venueId;
}

/** Normalize a raw writer label from Fantasy402 / GSLive / Exchange payloads into a canonical WriterLaneId. */
export function resolveWriterLaneId(rawWriter: string): WriterLaneId {
  const normalized = rawWriter.trim().toLowerCase();
  if (
    normalized === "inet" ||
    normalized === "internet" ||
    normalized === "mobile" ||
    normalized === "web" ||
    normalized === "f402" ||
    normalized === "fantasy402"
  ) {
    return "inet";
  }
  if (
    normalized === "gslive" ||
    normalized === "gs-live" ||
    normalized === "gs_live" ||
    normalized === "partner118" ||
    normalized === "partner_118" ||
    normalized === "gslive_partner118" ||
    normalized === "live"
  ) {
    return "gslive";
  }
  if (normalized === "gsbuilder" || normalized === "builder") {
    return "gsbuilder";
  }
  if (normalized === "gateway" || normalized === "gw") {
    return "gateway";
  }
  if (
    normalized === "cslevel2" ||
    normalized === "polymarket" ||
    normalized === "clob"
  ) {
    return "cslevel2";
  }
  if (normalized === "alert" || normalized === "kalshi") {
    return "alert";
  }
  if (
    normalized === "blocked" ||
    normalized === "internal" ||
    normalized === "r2" ||
    normalized === "desk"
  ) {
    return "blocked";
  }
  return "unknown";
}

/** Resolve canonical OriginDomainId for a raw writer label. */
export function resolveOriginDomainForWriter(
  rawWriter: string,
): OriginDomainId {
  return WRITER_LANE_REGISTRY[resolveWriterLaneId(rawWriter)].originDomainId;
}

/** Resolve canonical VenueId for a given OriginDomainId. */
export function resolveVenueIdForOrigin(
  originDomainId: OriginDomainId,
): VenueId {
  return ORIGIN_DOMAIN_REGISTRY[originDomainId].venueId;
}
