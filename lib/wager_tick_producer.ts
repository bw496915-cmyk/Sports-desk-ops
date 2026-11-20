/**
 * @file lib/wager_tick_producer.ts
 * @description Live wager-ticker rows -> `WagerTickInput` for the 32-byte telemetry
 * frame, plus a poll loop that publishes each mapped wager once.
 *
 * Feed shape (`data/live-wagers.json` top-level `LIST`): `WagerNumber` is the ticket id,
 * `AmountWagered` is risk in integer cents, `InsertDateTime` is the portal wall clock,
 * `TicketWriter` names the channel and `ShortDesc` carries the selection text.
 *
 * Deliberate boundaries:
 *  - `parseTickLineHundredths` accepts one bare line expression or one single-selection
 *    description. A description is split on `/`, and exactly one segment may yield
 *    exactly one line token (the token immediately before the price). A parlay with two
 *    priced lines returns null instead of reporting one leg as the ticket's line.
 *  - Totals keep the line magnitude: `Over 143.5` and `Under 143.5` both parse to
 *    `14350`, because the 32-byte frame has no over/under side bit. The side is not
 *    representable there.
 *  - A bare signed token whose magnitude is 100 or more is American odds, not a line —
 *    the repo already reads `ShortDesc` that way ("a price is never a line") — so it
 *    returns null instead of reporting a 140-point spread.
 *  - `InsertDateTime` is read with a fixed `-05:00` offset, as the slice contract states.
 *    The portal's documented zone is America/New_York (`lib/bet_flags.ts`), so the fixed
 *    offset is exact in EST and one hour off during EDT.
 *  - The producer deduplicates only wagers it actually published, so a row skipped for a
 *    missing line can still publish if a later poll carries a line for it.
 *  - `publish` is synchronous: its return value is ignored and a promise it returns is not
 *    awaited. A throw aborts the poll; ticks already published in that poll are not
 *    repeated, and the throwing tick is retried on the next poll.
 */

import type {
  BridgeChannelPackedWord32,
  Cents,
  EpochMs,
  LineHundredths,
} from "../design/domain-branded-types.ts";
import {
  asCents,
  asLineHundredths,
  encodeBridgeChannelPackedWord32,
} from "./bridge_and_channel_router.ts";
import { asWallEpochMs, type WagerTickInput } from "./wager_telemetry_hub.ts";

/**
 * One row of the `LIST` array. Only the fields the tick needs are named; the values are
 * `unknown` because this is external JSON, and every one of them is validated before use.
 */
export interface LiveWagerRow {
  /** Wire ticket id; a safe non-negative integer. */
  readonly WagerNumber?: unknown;
  /** Wire channel (`GSLIVE`, `Internet`, `ALERT`, …). */
  readonly TicketWriter?: unknown;
  /** Risk in integer cents, as the wire writes it. */
  readonly AmountWagered?: unknown;
  /** Portal wall clock, `YYYY-MM-DD HH:mm:ss.SSS`, fixed UTC-5. */
  readonly InsertDateTime?: unknown;
  /** Selection text; only a bare single-line expression yields a line. */
  readonly ShortDesc?: unknown;
}

/** `TicketWriter` starting with `GSLIVE` routes to the Partner118 tally bridge. */
export const GSLIVE_BRIDGE_ROUTE_WORD32: BridgeChannelPackedWord32 =
  encodeBridgeChannelPackedWord32(
    "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
    "GSLIVE",
  );

/** Every other writer routes to the F402 pending/grading bridge on the CWS channel. */
export const F402_BRIDGE_ROUTE_WORD32: BridgeChannelPackedWord32 =
  encodeBridgeChannelPackedWord32(
    "BRIDGE_02_F402_PENDING_AND_GRADING",
    "LIVE_CWS",
  );

const PORTAL_FIXED_OFFSET_MS = 5 * 60 * 60 * 1000;
const HUNDREDTHS_PER_POINT = 100;
/** Odds magnitude floor: `-100`/`+100` is the smallest American price, never a line. */
const MIN_ODDS_MAGNITUDE = 100;
const INT32_MAX = 0x7fff_ffff;

const HTML_ENTITY_RE = /&(?:#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;
const HTML_TAG_RE = /<[^>]*>/g;
const DECIMAL_LINE_RE = /^([+-]?)(\d*)(?:\.(\d{1,2}))?$/;
const TOTAL_LINE_RE = /^(?:over|under|o|u)\s+(.+)$/i;
const PORTAL_WALL_CLOCK_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

/**
 * The portal encodes line breaks three ways (real CR/LF, escaped `\r\n`, `&#x0D;`) and
 * half-points as `&#189;`. Fraction entities must be decoded before the generic entity
 * strip, and any other entity or tag is removed so a bare expression can be matched.
 */
function normalizeLineText(raw: string): string {
  return raw
    .replace(/&#x0d;?|&#13;?/gi, "\n")
    .replace(/&#x0a;?|&#10;?/gi, "\n")
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/&#x0*bd;|&#189;|&frac12;/gi, "½")
    .replace(/&#x0*bc;|&#188;|&frac14;/gi, "¼")
    .replace(/&#x0*be;|&#190;|&frac34;/gi, "¾")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(HTML_ENTITY_RE, "")
    .replace(HTML_TAG_RE, " ")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/½/g, ".5")
    .replace(/¼/g, ".25")
    .replace(/¾/g, ".75")
    .replace(/\s+/g, " ")
    .trim();
}

/** `3.5` -> 350, `-3.5` -> -350, `.5` -> 50; null when the token is not hundredths-exact. */
function decimalHundredths(text: string): number | null {
  const match = DECIMAL_LINE_RE.exec(text);
  if (match === null) return null;
  const whole = match[2] ?? "";
  const fraction = match[3];
  // A lone sign is not a line; an empty token is not either.
  if (whole === "" && fraction === undefined) return null;
  const wholeValue = whole === "" ? 0 : Number(whole);
  const fractionValue =
    fraction === undefined ? 0 : Number(fraction.padEnd(2, "0"));
  const value = wholeValue * HUNDREDTHS_PER_POINT + fractionValue;
  if (!Number.isSafeInteger(value)) return null;
  return match[1] === "-" && value !== 0 ? -value : value;
}

/** Odds are never lines: a spread of 100+ points is a misread price. */
const MAX_ODDS_AS_LINE_HUNDREDTHS = 100 * HUNDREDTHS_PER_POINT;

/**
 * One match per priced line: a total is the number after Over/Under (or O/U), a spread
 * is a signed or bare number immediately before a price. Occurrences are returned, not
 * distinct values, so two legs of the same magnitude still count as two lines.
 */
const PRICED_LINE_RE =
  /\b(?:over|under|o|u)\s+([+-]?\d+(?:\.\d+)?)\s+([+-]\d{2,4})\b|(?:^|\s)([+-]?\d+(?:\.\d+)?|pk)\s+([+-]\d{2,4})\b/gi;

function pricedLinesInSegment(segment: string): readonly number[] {
  const lines: number[] = [];
  for (const match of segment.matchAll(PRICED_LINE_RE)) {
    const totalToken = match[1];
    if (totalToken !== undefined) {
      const value = decimalHundredths(totalToken);
      if (value !== null && Math.abs(value) <= INT32_MAX) {
        lines.push(Math.abs(value));
      }
      continue;
    }
    const spreadToken = match[3];
    if (spreadToken === undefined) continue;
    if (/^pk$/i.test(spreadToken)) {
      lines.push(0);
      continue;
    }
    const value = decimalHundredths(spreadToken);
    if (value === null) continue;
    if (Math.abs(value) >= MAX_ODDS_AS_LINE_HUNDREDTHS) continue;
    lines.push(value);
  }
  return lines;
}

/**
 * Exactly one priced line across the description's `/` segments. Two priced segments
 * are a parlay: the ticket has no single line, so it is not representable.
 */
function extractDescriptionLine(normalized: string): LineHundredths | null {
  const lines: number[] = [];
  for (const segment of normalized.split("/")) {
    const segmentLines = pricedLinesInSegment(segment);
    if (segmentLines.length > 1) return null;
    if (segmentLines.length === 1) lines.push(segmentLines[0]!);
  }
  if (lines.length !== 1) return null;
  return asLineHundredths(lines[0]!);
}

/**
 * Parse a bare line expression or a single-selection description.
 *
 * Bare: `+3.5`, `-3.5`, `3.5`, `0`, `PK` (push), and totals written as
 * `Over 143.5` / `Under 143.5` (also `O`/`U`). Descriptions: the one line token
 * immediately before the price (`Texans -12.5 -110`, `O 112 -110`, `PK -110`,
 * `Over 0.5 -136`). CR/LF and HTML entities are normalised first. Returns `null` for a
 * moneyline/odds-only description, a parlay with two priced lines, a sub-hundredth
 * value, or an absent line.
 */
export function parseTickLineHundredths(
  shortDesc: string,
): LineHundredths | null {
  if (typeof shortDesc !== "string") return null;
  const normalized = normalizeLineText(shortDesc);
  if (normalized === "") return null;
  if (/^pk$/i.test(normalized)) return asLineHundredths(0);

  const total = TOTAL_LINE_RE.exec(normalized);
  if (total !== null) {
    const magnitude = decimalHundredths(total[1] ?? "");
    if (magnitude !== null && Math.abs(magnitude) <= INT32_MAX) {
      return asLineHundredths(Math.abs(magnitude));
    }
    // Not a bare total (`Over 0.5 -136`): let the description extractor price it.
  }

  const line = decimalHundredths(normalized);
  if (line !== null) {
    // A bare `-140` is an American price, not a 140-point spread.
    if (Math.abs(line) >= MIN_ODDS_MAGNITUDE * HUNDREDTHS_PER_POINT)
      return null;
    if (Math.abs(line) > INT32_MAX) return null;
    return asLineHundredths(line);
  }
  return extractDescriptionLine(normalized);
}

function parseWagerNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

type WriterChannel = "GSLIVE" | "LIVE_CWS";

function resolveWriterChannel(value: unknown): WriterChannel | null {
  if (typeof value !== "string") return null;
  return value.trim().toUpperCase().startsWith("GSLIVE")
    ? "GSLIVE"
    : "LIVE_CWS";
}

function parseStakeCents(value: unknown): Cents | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  // Non-negative and packable as the frame's int32 stake field.
  if (value < 0 || value > INT32_MAX) return null;
  return asCents(value === 0 ? 0 : value);
}

/**
 * `YYYY-MM-DD HH:mm:ss.SSS` (fixed UTC-5) -> epoch ms. The wall-clock components are
 * round-tripped so an impossible date (`2026-02-30`, hour 25) is null instead of silently
 * rolling over; a negative epoch cannot be represented and is null too.
 */
function parsePortalWallClock(value: unknown): EpochMs | null {
  if (typeof value !== "string") return null;
  const match = PORTAL_WALL_CLOCK_RE.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, millisecond);
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second
  ) {
    return null;
  }
  // The wall clock reads five hours behind UTC, so the UTC instant is the wall time plus
  // the offset (18:20 at UTC-5 is 23:20Z).
  const epochMs = wallClock.getTime() + PORTAL_FIXED_OFFSET_MS;
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) return null;
  return asWallEpochMs(epochMs);
}

type WagerRowOutcome =
  | {
      readonly kind: "tick";
      readonly wagerNumber: number;
      readonly tick: WagerTickInput;
    }
  | { readonly kind: "no-line" }
  | { readonly kind: "invalid" };

const INVALID_ROW: WagerRowOutcome = { kind: "invalid" };
const ROW_WITHOUT_LINE: WagerRowOutcome = { kind: "no-line" };

/**
 * Structural fields are validated first, so only a structurally valid row can be counted
 * as `skippedNoLine`; a row that is both malformed and line-less is `skippedInvalid`.
 */
function classifyWagerRow(row: unknown): WagerRowOutcome {
  if (row === null || typeof row !== "object") return INVALID_ROW;
  const wire: LiveWagerRow = row;
  const wagerNumber = parseWagerNumber(wire.WagerNumber);
  if (wagerNumber === null) return INVALID_ROW;
  const channel = resolveWriterChannel(wire.TicketWriter);
  if (channel === null) return INVALID_ROW;
  const stakeCents = parseStakeCents(wire.AmountWagered);
  if (stakeCents === null) return INVALID_ROW;
  const wallEpochMs = parsePortalWallClock(wire.InsertDateTime);
  if (wallEpochMs === null) return INVALID_ROW;
  const shortDesc = wire.ShortDesc;
  if (typeof shortDesc !== "string") return INVALID_ROW;

  const lineHundredths = parseTickLineHundredths(shortDesc);
  if (lineHundredths === null) return ROW_WITHOUT_LINE;

  return {
    kind: "tick",
    wagerNumber,
    tick: {
      routeWord32:
        channel === "GSLIVE"
          ? GSLIVE_BRIDGE_ROUTE_WORD32
          : F402_BRIDGE_ROUTE_WORD32,
      lineHundredths,
      stakeCents,
      wagerId: BigInt(wagerNumber),
      wallEpochMs,
    },
  };
}

/**
 * Map one wager row to its tick, or null when the row has no usable line or any field is
 * invalid. A `GSLIVE` writer rides the Partner118 tally bridge on the `GSLIVE` channel;
 * every other writer rides the F402 pending/grading bridge on the `LIVE_CWS` channel.
 */
export function wagerRowToTick(row: LiveWagerRow): WagerTickInput | null {
  const outcome = classifyWagerRow(row);
  return outcome.kind === "tick" ? outcome.tick : null;
}

export interface WagerTickProducerOptions {
  readonly readRows: () => Promise<readonly LiveWagerRow[]>;
  readonly publish: (tick: WagerTickInput) => unknown;
  /** Clock, injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Recent published keys remembered for dedupe (default 100,000). */
  readonly maxRememberedWagers?: number;
}

export interface WagerTickPollResult {
  /** Rows the source returned in this poll, duplicates included. */
  readonly read: number;
  /** Ticks published in this poll (a wager already published is never counted again). */
  readonly published: number;
  /** Structurally valid rows whose description yields no line (moneyline, prop, parlay). */
  readonly skippedNoLine: number;
  /** Rows rejected for a malformed field. */
  readonly skippedInvalid: number;
}

export interface WagerTickProducer {
  pollOnce(): Promise<WagerTickPollResult>;
  /** `now()` captured at the start of the latest poll; null before the first poll. */
  readonly lastPollAtEpochMs: number | null;
}

/**
 * Polling producer over an injected row source. The dedupe key is the bridge route plus
 * `WagerNumber` (the two platforms can use overlapping numbers), kept in a bounded recent
 * window so a long-running process does not grow one entry per wager forever. Only a wager
 * that was actually published enters the window, so it cannot suppress a tick that was
 * never sent.
 */
export function createWagerTickProducer(
  options: WagerTickProducerOptions,
): WagerTickProducer {
  const { readRows, publish } = options;
  const now = options.now ?? Date.now;
  const maxRememberedWagers = options.maxRememberedWagers ?? 100_000;
  if (!Number.isInteger(maxRememberedWagers) || maxRememberedWagers < 1) {
    throw new RangeError(
      `maxRememberedWagers must be a positive integer, received ${String(maxRememberedWagers)}`,
    );
  }
  const rememberedWagerKeys = new Set<string>();
  let lastPollAtEpochMs: number | null = null;

  return {
    get lastPollAtEpochMs(): number | null {
      return lastPollAtEpochMs;
    },

    async pollOnce(): Promise<WagerTickPollResult> {
      lastPollAtEpochMs = now();
      const rows = await readRows();
      let published = 0;
      let skippedNoLine = 0;
      let skippedInvalid = 0;

      for (const row of rows) {
        const outcome = classifyWagerRow(row);
        if (outcome.kind === "invalid") {
          skippedInvalid++;
          continue;
        }
        if (outcome.kind === "no-line") {
          skippedNoLine++;
          continue;
        }
        const key = `${outcome.tick.routeWord32}:${outcome.wagerNumber}`;
        if (rememberedWagerKeys.has(key)) continue;
        publish(outcome.tick);
        rememberedWagerKeys.add(key);
        published++;
        if (rememberedWagerKeys.size > maxRememberedWagers) {
          const oldest = rememberedWagerKeys.values().next().value;
          if (oldest !== undefined) rememberedWagerKeys.delete(oldest);
        }
      }

      return { read: rows.length, published, skippedNoLine, skippedInvalid };
    },
  };
}
