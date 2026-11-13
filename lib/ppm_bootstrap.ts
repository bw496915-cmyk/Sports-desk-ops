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
 *   c[eventId].c = { m?: { [marketId]: market }, h1?: …, h2?: … }
 *   market      = { o: { [selectionKey]: number | [number, number] },
 *                   r?: line, d?: { [key]: name } }
 *
 * Prices are **decimal** already (1.909091 = -110), so they never pass through
 * the display quantization that `ppm_price_math` documents.
 */

export interface PpmPricePoint {
  /** Selection id (`"1"`, `"2"`) or the line as a string (`"48.5"`, `"-3.5"`). */
  readonly key: string;
  /** Numeric value of the key when it is a line; `null` for a selection id. */
  readonly line: number | null;
  /** Index inside a two-sided value (`[over, under]`); `null` for a scalar. */
  readonly side: number | null;
  readonly decimal: number;
}

export interface PpmMarketPrices {
  readonly marketId: number;
  readonly period: "full" | "h1" | "h2";
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

function asDecimal(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 1
    ? value
    : null;
}

function parseMarketNode(
  marketId: number,
  period: PpmMarketPrices["period"],
  node: unknown,
): PpmMarketPrices | null {
  if (!isRecord(node) || !isRecord(node.o)) return null;
  const points: PpmPricePoint[] = [];
  for (const [key, raw] of Object.entries(node.o)) {
    const numericKey = Number(key);
    const line =
      Number.isFinite(numericKey) && key.trim() !== "" ? numericKey : null;
    if (Array.isArray(raw)) {
      raw.forEach((value, side) => {
        const decimal = asDecimal(value);
        if (decimal !== null) points.push({ key, line, side, decimal });
      });
    } else {
      const decimal = asDecimal(raw);
      if (decimal !== null) points.push({ key, line, side: null, decimal });
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
): PpmEventPrices {
  if (!isRecord(entry) || !isRecord(entry.c)) {
    return { eventId, markets: [] };
  }
  const markets: PpmMarketPrices[] = [];
  for (const [periodKey, periodValue] of Object.entries(entry.c)) {
    const period: PpmMarketPrices["period"] =
      periodKey === "m"
        ? "full"
        : periodKey === "h1"
          ? "h1"
          : periodKey === "h2"
            ? "h2"
            : "full";
    if (!isRecord(periodValue)) continue;
    for (const [marketKey, node] of Object.entries(periodValue)) {
      const marketId = Number(marketKey);
      if (!Number.isSafeInteger(marketId)) continue;
      const parsed = parseMarketNode(marketId, period, node);
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
export function parsePpmBootstrap(payload: unknown): PpmBootstrap {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(first) || !isRecord(first.c)) {
    throw new Error("ppm bootstrap: expected [{ c: { eventId: … } }]");
  }
  const events: PpmEventPrices[] = [];
  let markets = 0;
  let pricePoints = 0;
  for (const [eventId, entry] of Object.entries(first.c)) {
    const parsed = parsePpmEventPrices(eventId, entry);
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
