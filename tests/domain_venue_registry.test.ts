import { describe, expect, test } from "bun:test";

import {
  ORIGIN_DOMAIN_REGISTRY,
  VENUE_REGISTRY,
  WRITER_LANE_REGISTRY,
  isOriginDomainId,
  isVenueId,
  isWriterLaneId,
  parseVenueId,
  resolveVenueIdForOrigin,
  resolveVenueIdForWriter,
  resolveWriterLaneId,
  venueEntry,
  type OriginDomainId,
  type VenueId,
  type WriterLaneId,
} from "../lib/domain_venue_registry.ts";

describe("venue registry", () => {
  test("every venue id has an entry whose id matches its key", () => {
    for (const [id, entry] of Object.entries(VENUE_REGISTRY)) {
      expect(entry.venueId).toBe(id as VenueId);
      expect(entry.displayLabel.length).toBeGreaterThan(0);
      expect(entry.brandColorHex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("every origin resolves to a venue that lists it, and nothing is orphaned", () => {
    const listed = new Set<string>();
    for (const origin of Object.keys(ORIGIN_DOMAIN_REGISTRY) as OriginDomainId[]) {
      const venueId = ORIGIN_DOMAIN_REGISTRY[origin].venueId;
      expect(VENUE_REGISTRY[venueId]).toBeDefined();
      expect(VENUE_REGISTRY[venueId].originDomainIds).toContain(origin);
      listed.add(origin);
    }
    for (const entry of Object.values(VENUE_REGISTRY)) {
      for (const origin of entry.originDomainIds) expect(listed.has(origin)).toBe(true);
    }
  });

  test("every writer lane agrees with its origin about the venue", () => {
    for (const lane of Object.keys(WRITER_LANE_REGISTRY) as WriterLaneId[]) {
      const entry = WRITER_LANE_REGISTRY[lane];
      expect(resolveVenueIdForOrigin(entry.originDomainId)).toBe(entry.venueId);
      expect(resolveVenueIdForWriter(lane)).toBe(entry.venueId);
    }
  });

  test("the kind of book is stated per venue, not inferred from the colour", () => {
    expect(VENUE_REGISTRY.f402.kind).toBe("sportsbook");
    expect(VENUE_REGISTRY.gslive_partner118.kind).toBe("sportsbook");
    expect(VENUE_REGISTRY.polymarket.kind).toBe("exchange");
    expect(VENUE_REGISTRY.kalshi.kind).toBe("exchange");
    expect(VENUE_REGISTRY.internal.kind).toBe("internal");
  });
});

describe("boundary parsing", () => {
  test("parses canonical ids and external spellings, and refuses the rest", () => {
    expect(parseVenueId("polymarket")).toBe("polymarket");
    expect(parseVenueId("  F402 ")).toBe("f402");
    expect(parseVenueId("Fantasy402")).toBe("f402");
    expect(parseVenueId("GS-LIVE")).toBe("gslive_partner118");
    expect(parseVenueId("ctf")).toBe("polymarket");
    expect(parseVenueId("coinbase")).toBeNull();
    expect(parseVenueId("")).toBeNull();
    expect(parseVenueId(null)).toBeNull();
    expect(parseVenueId(42)).toBeNull();
  });

  test("type guards agree with the registries and reject lookalikes", () => {
    expect(isVenueId("f402")).toBe(true);
    expect(isVenueId("f402 ")).toBe(false);
    expect(isVenueId("ORIGIN_SPORTSBOOK_FANTASY402")).toBe(false);
    expect(isOriginDomainId("ORIGIN_EXCHANGE_KALSHI_REGULATED")).toBe(true);
    expect(isOriginDomainId("f402")).toBe(false);
    expect(isWriterLaneId("cslevel2")).toBe(true);
    expect(isWriterLaneId("polymarket")).toBe(false);
  });

  test("venueEntry is total for every declared VenueId", () => {
    for (const id of Object.keys(VENUE_REGISTRY) as VenueId[]) {
      expect(venueEntry(id).venueId).toBe(id);
    }
  });
});

describe("an unresolved writer is not a blocked one", () => {
  test("garbage resolves to the unknown lane, labelled UNRESOLVED", () => {
    expect(resolveWriterLaneId("mystery-writer")).toBe("unknown");
    expect(WRITER_LANE_REGISTRY.unknown.provenanceLabel).toBe("UNRESOLVED");
  });

  test("the blocked lane keeps its own label and is reached by its own spelling", () => {
    expect(resolveWriterLaneId("BLOCKED")).toBe("blocked");
    expect(WRITER_LANE_REGISTRY.blocked.provenanceLabel).toBe("BLOCKED");
    expect(WRITER_LANE_REGISTRY.unknown.provenanceLabel).not.toBe(
      WRITER_LANE_REGISTRY.blocked.provenanceLabel,
    );
  });
});
