/**
 * @file lib/domain-enums.ts
 * @description Numeric uint8 wire ids for the NSH frame's origin-domain and
 * writer-lane slots (bytes 56, 57). The canonical identifiers live in
 * `lib/domain_venue_registry.ts` as string unions (`OriginDomainId`,
 * `WriterLaneId`); a 64-byte frame cannot carry a string, so this module is the
 * single place that assigns stable byte values and maps between the two
 * representations. Never add a second numeric table elsewhere.
 *
 * Values are frozen and may only be appended: an id is part of the wire format.
 *
 * Bitwise Rule: both tables are `uint8` (`0..255`) and are validated on read,
 * so an unknown byte fails closed instead of decoding into a wrong domain.
 */

import type { OriginDomainId, WriterLaneId } from "./domain_venue_registry.ts";
import type { SignalChannelCode } from "../design/domain-branded-types.ts";

/**
 * Origin domain, uint8 @ byte 56. Values mirror the six entries of
 * `ORIGIN_DOMAIN_REGISTRY`; `UNSET` is the only non-domain value.
 */
export const OriginDomainWireId = Object.freeze({
  UNSET: 0,
  F402: 1,
  GSLIVE_118: 2,
  POLYMARKET_CTF: 3,
  KALSHI_REGULATED: 4,
  STORAGE_R2_LAKEHOUSE: 5,
  HOST_NSH_DESK_LOCAL: 6,
} as const);

export type OriginDomainWireId =
  (typeof OriginDomainWireId)[keyof typeof OriginDomainWireId];

/**
 * Writer lane, uint8 @ byte 57. Values mirror the eight entries of
 * `WRITER_LANE_REGISTRY`.
 */
export const WriterLaneWireId = Object.freeze({
  UNKNOWN: 0,
  ALERT: 1,
  GSLIVE: 2,
  INTERNET: 3,
  GSBUILDER: 4,
  CSLEVEL2: 5,
  GATEWAY: 6,
  BLOCKED: 7,
} as const);

export type WriterLaneWireId =
  (typeof WriterLaneWireId)[keyof typeof WriterLaneWireId];

/** Registry id -> wire id. Total over `OriginDomainId`. */
export const ORIGIN_DOMAIN_WIRE_ID: Readonly<
  Record<OriginDomainId, OriginDomainWireId>
> = Object.freeze({
  ORIGIN_SPORTSBOOK_FANTASY402: OriginDomainWireId.F402,
  ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118: OriginDomainWireId.GSLIVE_118,
  ORIGIN_EXCHANGE_POLYMARKET_CTF: OriginDomainWireId.POLYMARKET_CTF,
  ORIGIN_EXCHANGE_KALSHI_REGULATED: OriginDomainWireId.KALSHI_REGULATED,
  ORIGIN_STORAGE_R2_LAKEHOUSE: OriginDomainWireId.STORAGE_R2_LAKEHOUSE,
  ORIGIN_HOST_NSH_DESK_LOCAL: OriginDomainWireId.HOST_NSH_DESK_LOCAL,
});

/** Registry id -> wire id. Total over `WriterLaneId`. */
export const WRITER_LANE_WIRE_ID: Readonly<
  Record<WriterLaneId, WriterLaneWireId>
> = Object.freeze({
  unknown: WriterLaneWireId.UNKNOWN,
  alert: WriterLaneWireId.ALERT,
  gslive: WriterLaneWireId.GSLIVE,
  inet: WriterLaneWireId.INTERNET,
  gsbuilder: WriterLaneWireId.GSBUILDER,
  cslevel2: WriterLaneWireId.CSLEVEL2,
  gateway: WriterLaneWireId.GATEWAY,
  blocked: WriterLaneWireId.BLOCKED,
});

/** Wire id -> registry id; the inverse of `ORIGIN_DOMAIN_WIRE_ID`. */
export const ORIGIN_DOMAIN_BY_WIRE_ID: Readonly<
  Record<number, OriginDomainId>
> = Object.freeze({
  [OriginDomainWireId.F402]: "ORIGIN_SPORTSBOOK_FANTASY402",
  [OriginDomainWireId.GSLIVE_118]: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
  [OriginDomainWireId.POLYMARKET_CTF]: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
  [OriginDomainWireId.KALSHI_REGULATED]: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
  [OriginDomainWireId.STORAGE_R2_LAKEHOUSE]: "ORIGIN_STORAGE_R2_LAKEHOUSE",
  [OriginDomainWireId.HOST_NSH_DESK_LOCAL]: "ORIGIN_HOST_NSH_DESK_LOCAL",
});

/** Wire id -> registry id; the inverse of `WRITER_LANE_WIRE_ID`. */
export const WRITER_LANE_BY_WIRE_ID: Readonly<Record<number, WriterLaneId>> =
  Object.freeze({
    [WriterLaneWireId.UNKNOWN]: "unknown",
    [WriterLaneWireId.ALERT]: "alert",
    [WriterLaneWireId.GSLIVE]: "gslive",
    [WriterLaneWireId.INTERNET]: "inet",
    [WriterLaneWireId.GSBUILDER]: "gsbuilder",
    [WriterLaneWireId.CSLEVEL2]: "cslevel2",
    [WriterLaneWireId.GATEWAY]: "gateway",
    [WriterLaneWireId.BLOCKED]: "blocked",
  });

/**
 * Router provenance token -> writer lane. The bridge resolver yields a
 * `SignalChannelCode`, not a raw writer label, so frame packing needs this
 * bridge between the two vocabularies. Total over `SignalChannelCode`.
 */
export const WRITER_LANE_WIRE_ID_BY_SIGNAL_CHANNEL: Readonly<
  Record<SignalChannelCode, WriterLaneWireId>
> = Object.freeze({
  Internet: WriterLaneWireId.INTERNET,
  BLOCKED: WriterLaneWireId.BLOCKED,
  GATEWAY: WriterLaneWireId.GATEWAY,
  ALERT: WriterLaneWireId.ALERT,
  GSBUILDER: WriterLaneWireId.GSBUILDER,
  GSLIVE: WriterLaneWireId.GSLIVE,
  CSLEVEL2: WriterLaneWireId.CSLEVEL2,
});

/** Maps a canonical origin domain onto its wire id. */
export function originDomainWireIdOf(
  originDomainId: OriginDomainId,
): OriginDomainWireId {
  return ORIGIN_DOMAIN_WIRE_ID[originDomainId];
}

/** Maps a canonical writer lane onto its wire id. */
export function writerLaneWireIdOf(
  writerLaneId: WriterLaneId,
): WriterLaneWireId {
  return WRITER_LANE_WIRE_ID[writerLaneId];
}

/** Inverse of `originDomainWireIdOf`; `null` for an unmapped byte. */
export function originDomainIdOfWireId(wireId8: number): OriginDomainId | null {
  return ORIGIN_DOMAIN_BY_WIRE_ID[wireId8] ?? null;
}

/** Inverse of `writerLaneWireIdOf`; `null` for an unmapped byte. */
export function writerLaneIdOfWireId(wireId8: number): WriterLaneId | null {
  return WRITER_LANE_BY_WIRE_ID[wireId8] ?? null;
}
