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
    provenanceLabel: "BLOCKED",
    brandColorHex: "#64748b",
  },
};

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
