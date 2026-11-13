/**
 * @file lib/ppm_bootstrap.ts
 * @description The price bootstrap: `GET /betLobbyV2/getUpdates/?groupId=…`.
 *
 * The socket feed ships market *descriptors* and per-event deltas; the full
 * price table comes from this HTTP call. Measured 2026-11-13, anonymously:
 *
 *   /betLobbyV2/getUpdates/?since=0&store=U0VWU1NWUkJSMFU9
 *     &includeNotStarted=1&groupId=72105&partnerId=118     -> 23 MB
 *   /betLobbyV2/getUpdates/?since=0&store=…                -> [{},{},{},{}]
 *
 * **The `groupId` (and `includeNotStarted`) are what unlock it** — not a
 * session, and not credentials. That corrects an earlier reading of the empty
 * per-event coefficient frames: those carry descriptors, and an event with no
 * open market legitimately has `c: []`.
 *
 * Shape of the first payload section:
 *
 *   { t, s, c, m, f, db }
 *   c[eventId].c = { m?: { [marketId]: market }, h1?: …, s1?: …, … }
 *   market      = { o: { [selectionKey]: number | [number, number] },
 *                   r?: line, d?: { [key]: name } }
 *
 * Prices are **decimal** already (1.909091 = -110), so they never pass through
 * the display quantization that `ppm_price_math` documents.
 *
 * Two value encodings share the same object, and they do not mean the same
 * thing:
 *
 * - `[over, under]` on a line key (`"48.5"`, `"-3.5"`) — both elements are
 *   prices and the key is the line.
 * - `[price, 1.00001]` on an outcome key (`"2"`, `"65538"`, a player id) — one
 *   real price and one placeholder. The second element is not a 1.00001-odds
 *   offer; emitting it would invent a price no book quotes.
 *
 * Only the first form carries a line; a per-outcome key never does, even when
 * it happens to be numeric.
 */

export interface PpmPricePoint {
  /** Selection id (`"1"`, `"2"`) or the line as a string (`"48.5"`, `"-3.5"`). */
  readonly key: string;
  /** Numeric value of the key when it is a line; `null` for a selection id. */
  readonly line: number | null;
  /**
   * Index inside the pair for a line-keyed market (0 = over/home, 1 =
   * under/away); `null` for an outcome-keyed or scalar value.
   */
  readonly side: number | null;
  readonly decimal: number;
}

export interface PpmMarketPrices {
  readonly marketId: number;
  /**
   * Period code as the feed names it: `m` is mapped to `full`; `h1`/`h2` and
   * the `s1`…`s13` codes (set/period markets) pass through unchanged rather
   * than being folded into `full`.
   */
  readonly period: string;
  /** Line carried by the market node itself (`r`), when present. */
  readonly line: number | null;
  readonly points: readonly PpmPricePoint[];
}

export interface PpmEventPrices {
  readonly eventId: string;
  readonly markets: readonly PpmMarketPrices[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The feed writes `1.00001` (and `1.000001`) into the side of a quote that has
 * no offer — a placeholder, not a price. Measured over the full 2026-11-13
 * bootstrap: 285,981 of 859,006 two-element values carried exactly one of those
 * two numbers, and nothing real appeared between them and 1.83. The floor sits
 * below the 1.005–1.01 quotes a few exotic markets do carry, so those survive
 * while the placeholders do not.
 */
export const PPM_PLACEHOLDER_DECIMAL = 1.001;

function asDecimal(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > PPM_PLACEHOLDER_DECIMAL
    ? value
    : null;
}

/**
 * Markets whose `o` is keyed by a **line** and whose pair is the two sides of
 * that line (`[over, under]`, `[home, away]`). GSLive's wagertype metadata
 * names them: 5 Total (bId 2), 6 Spread (bId 1), 7/8 Team Total (bId 3/4).
 * Every other market keys on an outcome/selection id and quotes one price per
 * key; its second element is a placeholder.
 *
 * This is metadata the payload does not carry — `parsePpmBootstrap` accepts an
 * override so a caller holding `eventsMetadata` can extend or replace it.
 * Outside the set, a market is read one price per key: an exotic two-price
 * quote (exact total, winning margin) names its outcome in the key, not a line,
 * so it is not given sides here.
 */
export const PPM_LINE_KEYED_MARKETS: ReadonlySet<number> = new Set([
  5, 6, 7, 8,
]);

export interface PpmBootstrapOptions {
  readonly lineKeyedMarkets?: ReadonlySet<number>;
}

function parseMarketNode(
  marketId: number,
  period: string,
  node: unknown,
  lineKeyed: boolean,
): PpmMarketPrices | null {
  if (!isRecord(node) || !isRecord(node.o)) return null;
  const points: PpmPricePoint[] = [];
  for (const [key, raw] of Object.entries(node.o)) {
    const numericKey = Number(key);
    const numeric = Number.isFinite(numericKey) && key.trim() !== "";
    if (Array.isArray(raw)) {
      const values = raw.map(asDecimal);
      if (lineKeyed) {
        // Both sides of a line. A side that is unavailable is a placeholder,
        // not a 1.000001 offer: drop it and keep its sibling, so the line is
        // one-sided rather than mispriced.
        values.forEach((decimal, side) => {
          if (decimal !== null) {
            points.push({
              key,
              line: numeric ? numericKey : null,
              side,
              decimal,
            });
          }
        });
        continue;
      }
      // Outcome-keyed: the first element is the price, the rest is filler.
      const decimal = values[0] ?? null;
      if (decimal !== null) {
        points.push({ key, line: null, side: null, decimal });
      }
      continue;
    }
    const decimal = asDecimal(raw);
    if (decimal !== null) {
      points.push({ key, line: null, side: null, decimal });
    }
  }
  if (points.length === 0) return null;
  return {
    marketId,
    period,
    line: typeof node.r === "number" ? node.r : null,
    points,
  };
}

/** Parses one event's coefficient entry (`c[eventId].c`). */
export function parsePpmEventPrices(
  eventId: string,
  entry: unknown,
  options: PpmBootstrapOptions = {},
): PpmEventPrices {
  if (!isRecord(entry) || !isRecord(entry.c)) {
    return { eventId, markets: [] };
  }
  const lineKeyedMarkets = options.lineKeyedMarkets ?? PPM_LINE_KEYED_MARKETS;
  const markets: PpmMarketPrices[] = [];
  for (const [periodKey, periodValue] of Object.entries(entry.c)) {
    // `m` is the full match; `h1`/`h2` and `s1`…`s13` are already the feed's
    // own names. Folding an unknown code into `full` would claim a market the
    // payload did not say it was.
    const period = periodKey === "m" ? "full" : periodKey;
    if (!isRecord(periodValue)) continue;
    for (const [marketKey, node] of Object.entries(periodValue)) {
      const marketId = Number(marketKey);
      if (!Number.isSafeInteger(marketId)) continue;
      const parsed = parseMarketNode(
        marketId,
        period,
        node,
        lineKeyedMarkets.has(marketId),
      );
      if (parsed) markets.push(parsed);
    }
  }
  return { eventId, markets };
}

export interface PpmBootstrap {
  /** Feed timestamp of the payload, epoch milliseconds. */
  readonly updatedAtMs: number | null;
  readonly events: readonly PpmEventPrices[];
  readonly counts: {
    readonly eventsWithPrices: number;
    readonly markets: number;
    readonly pricePoints: number;
  };
}

/**
 * Parses the first section of a `getUpdates` payload. Events without open
 * markets are returned with `markets: []` rather than dropped, so "no price" is
 * visible instead of absent.
 */
export function parsePpmBootstrap(
  payload: unknown,
  options: PpmBootstrapOptions = {},
): PpmBootstrap {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(first) || !isRecord(first.c)) {
    throw new Error("ppm bootstrap: expected [{ c: { eventId: … } }]");
  }
  const events: PpmEventPrices[] = [];
  let markets = 0;
  let pricePoints = 0;
  for (const [eventId, entry] of Object.entries(first.c)) {
    const parsed = parsePpmEventPrices(eventId, entry, options);
    events.push(parsed);
    markets += parsed.markets.length;
    for (const market of parsed.markets) pricePoints += market.points.length;
  }
  return {
    updatedAtMs: typeof first.t === "number" ? first.t : null,
    events,
    counts: {
      eventsWithPrices: events.filter((event) => event.markets.length > 0)
        .length,
      markets,
      pricePoints,
    },
  };
}
