/**
 * Web-standard (Cloudflare Workers + Bun compatible) Pandora/Spandora Socket.IO wire decoder,
 * RFC-6902 JSON Patch applicator, and live event/score extractors.
 *
 * Uses `DecompressionStream("gzip")` + `crypto.subtle.digest("SHA-256", ...)` with zero Bun-only
 * or Node-only runtime dependencies and zero module-scope entropy.
 *
 * @file workers/ppm-live-ticks/src/spandora_wire.ts
 */

export type PpmFeedFlavor = "live" | "prematch";

export const PPM_DEFAULT_LINE_SET = "U0VWU1NWUkJSMFU9";
export const PPM_LIVE_EVENT_DATA_TOPIC = `live.main.${PPM_DEFAULT_LINE_SET}.eventData`;

export function eventDataTopicForFlavor(
  lineSet = PPM_DEFAULT_LINE_SET,
  flavor: PpmFeedFlavor = "live",
): string {
  return `${flavor}.main.${lineSet}.eventData`;
}

export function liveCoefficientsTopic(
  eventId: number | string,
  lineSet = PPM_DEFAULT_LINE_SET,
  flavor: PpmFeedFlavor = "live",
): string {
  return `${flavor}.main.${lineSet}.eventCoefficients.${eventId}`;
}

export interface LeagueCatalogEntry {
  readonly leagueId: number;
  readonly name: string | null;
  readonly slug: string | null;
}

export type PpmMarketKind =
  "SPREAD" | "TOTAL" | "TEAM_TOTAL" | "MONEYLINE" | "OTHER";

export interface PpmExtractedMarketLine {
  readonly marketId: number;
  readonly marketKind: PpmMarketKind;
  readonly periodKey: string;
  readonly periodKind: string;
  readonly line: number | null;
  readonly oddsA: number | null;
  readonly oddsB: number | null;
  readonly twoSided: boolean;
}

export interface JsonPatchOp {
  readonly op: "add" | "replace" | "remove" | string;
  readonly path: string;
  readonly value?: unknown;
}

export interface DecodedSpandoraFrame {
  readonly isDiff: boolean;
  readonly payload: Record<string, unknown> | null;
  readonly patch: readonly JsonPatchOp[] | null;
  readonly ti: {
    readonly h?: string;
    readonly lfh?: string;
    readonly t?: number;
  } | null;
  readonly rawSha256: string;
}

export interface LiveEventMeta {
  readonly eventId: number;
  readonly sportId: number;
  readonly leagueId: number;
  readonly inPlay: boolean;
  readonly isBlocked: boolean;
  readonly halfTime: boolean;
  readonly stateCode: number;
}

export interface ScoreSnapshot {
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  readonly period: number | null;
  readonly clockSec: number | null;
  readonly updatedAtMs: number | null;
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});
const UTF8_ENCODER = new TextEncoder();

export const EVENT_DATA_LOCK_RE =
  /^\/s\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/12\/(l|ip|ht|s)$/;
export const EVENT_DATA_REMOVE_RE = /^\/s\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

async function gunzipBounded(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const writePromise = writer.write(copy).then(() => writer.close());

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_DECOMPRESSED_BYTES) {
          throw new Error(
            `spandora gzip payload exceeds ${MAX_DECOMPRESSED_BYTES} bytes`,
          );
        }
        chunks.push(value);
      }
    }
    await writePromise;
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  let view: Uint8Array<ArrayBuffer>;
  if (typeof data === "string") {
    view = UTF8_ENCODER.encode(data) as Uint8Array<ArrayBuffer>;
  } else {
    view = new Uint8Array(data.byteLength);
    view.set(data);
  }
  const digest = await crypto.subtle.digest("SHA-256", view);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Decode a gzip-compressed binary Socket.IO attachment from Pandora/Spandora.
 * Preserves BOTH `isDiff: false` object snapshots AND `isDiff: true` RFC-6902 patch arrays.
 */
export async function decodeSpandoraFrame(
  bytes: Uint8Array,
): Promise<DecodedSpandoraFrame> {
  if (
    bytes.byteLength < 2 ||
    bytes[0] !== GZIP_MAGIC_0 ||
    bytes[1] !== GZIP_MAGIC_1
  ) {
    throw new Error("spandora frame is not gzip-compressed");
  }
  const decompressed = await gunzipBounded(bytes);
  const text = UTF8_DECODER.decode(decompressed);
  const rawSha256 = await sha256Hex(text);
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || typeof parsed.isDiff !== "boolean") {
    throw new Error("spandora frame missing boolean isDiff");
  }

  const rawTi = isRecord(parsed.ti)
    ? {
        ...(typeof parsed.ti.h === "string" ? { h: parsed.ti.h } : {}),
        ...(typeof parsed.ti.lfh === "string" ? { lfh: parsed.ti.lfh } : {}),
        ...(typeof parsed.ti.t === "number" ? { t: parsed.ti.t } : {}),
      }
    : null;

  if (Array.isArray(parsed.payload)) {
    const patch: JsonPatchOp[] = [];
    for (const item of parsed.payload) {
      if (
        isRecord(item) &&
        typeof item.op === "string" &&
        typeof item.path === "string"
      ) {
        patch.push({
          op: item.op,
          path: item.path,
          ...(item.value !== undefined ? { value: item.value } : {}),
        });
      }
    }
    return {
      isDiff: parsed.isDiff,
      payload: null,
      patch,
      ti: rawTi,
      rawSha256,
    };
  }

  return {
    isDiff: parsed.isDiff,
    payload: isRecord(parsed.payload) ? parsed.payload : null,
    patch: null,
    ti: rawTi,
    rawSha256,
  };
}

/** Extract the topic name from a Socket.IO binary attachment header (`451-["topic",{"_placeholder":true,"num":0}]`). */
export function parseBinaryAttachmentTopic(frame: string): string | null {
  if (!frame.startsWith("451-")) return null;
  try {
    const parsed = JSON.parse(frame.slice(4)) as unknown;
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      parsed[0].length > 0
    ) {
      return parsed[0];
    }
  } catch {
    return null;
  }
  return null;
}

function unescapeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Minimal zero-dependency RFC-6902 JSON Patch applicator (`add`, `replace`, `remove`).
 */
export function applyJsonPatchInPlace(
  root: Record<string, unknown>,
  ops: readonly JsonPatchOp[],
): void {
  for (const op of ops) {
    if (!op.path.startsWith("/")) continue;
    const segments = op.path.slice(1).split("/").map(unescapeJsonPointerToken);
    if (segments.length === 0) continue;

    let cursor: unknown = root;
    let valid = true;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!;
      if (Array.isArray(cursor)) {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
          valid = false;
          break;
        }
        cursor = cursor[idx];
      } else if (isRecord(cursor)) {
        if (!(seg in cursor)) {
          if (op.op === "add" || op.op === "replace") {
            cursor[seg] = {};
          } else {
            valid = false;
            break;
          }
        }
        cursor = cursor[seg];
      } else {
        valid = false;
        break;
      }
    }
    if (!valid || cursor === null || typeof cursor !== "object") continue;

    const leaf = segments[segments.length - 1]!;
    if (Array.isArray(cursor)) {
      if (op.op === "add" && leaf === "-") {
        cursor.push(op.value);
        continue;
      }
      const idx = Number(leaf);
      if (!Number.isInteger(idx) || idx < 0) continue;
      if (op.op === "remove") {
        if (idx < cursor.length) cursor.splice(idx, 1);
      } else if (op.op === "add") {
        if (idx <= cursor.length) cursor.splice(idx, 0, op.value);
      } else if (op.op === "replace") {
        if (idx < cursor.length) cursor[idx] = op.value;
      }
    } else if (isRecord(cursor)) {
      if (op.op === "remove") {
        delete cursor[leaf];
      } else if (op.op === "add" || op.op === "replace") {
        cursor[leaf] = op.value;
      }
    }
  }
}

/** Extract live event metadata entries from a decoded `eventData` snapshot payload. */
export function extractLiveEventsFromEventData(
  payload: Record<string, unknown>,
): LiveEventMeta[] {
  const out: LiveEventMeta[] = [];
  const sports = payload.s;
  if (!isRecord(sports)) return out;

  for (const [sportKey, countries] of Object.entries(sports)) {
    const sportId = Number(sportKey);
    if (!isRecord(countries)) continue;
    for (const leagues of Object.values(countries)) {
      if (!isRecord(leagues)) continue;
      for (const [leagueKey, events] of Object.entries(leagues)) {
        const leagueId = Number(leagueKey);
        if (!isRecord(events)) continue;
        for (const [eidKey, row] of Object.entries(events)) {
          const eventId = Number(eidKey);
          if (
            !Number.isFinite(eventId) ||
            eventId <= 0 ||
            !Array.isArray(row) ||
            row.length === 0
          ) {
            continue;
          }
          const tail = row[row.length - 1];
          const slot12 = isRecord(tail) ? tail : row[12];
          if (!isRecord(slot12)) continue;
          const inPlay = slot12.ip === true || slot12.ip === 1;
          const isBlocked = slot12.l === true || slot12.l === 1;
          const halfTime = slot12.ht === true || slot12.ht === 1;
          const stateCode = typeof slot12.s === "number" ? slot12.s : 0;
          out.push({
            eventId,
            sportId: Number.isFinite(sportId) ? sportId : 0,
            leagueId: Number.isFinite(leagueId) ? leagueId : 0,
            inPlay,
            isBlocked,
            halfTime,
            stateCode,
          });
        }
      }
    }
  }
  return out;
}

/** Extract live score, period, clock, and upstream timestamp from an `eventCoefficients.<eID>` object. */
export function extractScoreSnapshot(
  doc: Record<string, unknown>,
): ScoreSnapshot {
  const meta = doc.m;
  if (!isRecord(meta)) {
    return {
      homeScore: null,
      awayScore: null,
      period: null,
      clockSec: null,
      updatedAtMs: null,
    };
  }
  const scores = Array.isArray(meta.m) ? meta.m : null;
  const homeRaw = scores && scores.length >= 2 ? Number(scores[0]) : Number.NaN;
  const awayRaw = scores && scores.length >= 2 ? Number(scores[1]) : Number.NaN;
  const periodRaw = typeof meta.gp === "number" ? meta.gp : Number.NaN;
  const clockRaw = typeof meta.t === "number" ? meta.t : Number.NaN;
  const tuRaw = typeof meta.tu === "number" ? meta.tu : Number.NaN;
  return {
    homeScore: Number.isFinite(homeRaw) ? homeRaw : null,
    awayScore: Number.isFinite(awayRaw) ? awayRaw : null,
    period: Number.isFinite(periodRaw) ? periodRaw : null,
    clockSec: Number.isFinite(clockRaw) ? clockRaw : null,
    updatedAtMs: Number.isFinite(tuRaw) ? tuRaw : null,
  };
}

/**
 * Extract `(leagueId, name, slug)` entries from a decoded `live.leagues` or `prematch.leagues`
 * snapshot payload (`{ "4": { n: "NFL", in: "nfl" }, "5": { in: "ncaa" }, ... }`).
 */
export function extractLeagueCatalog(
  payload: Record<string, unknown>,
): LeagueCatalogEntry[] {
  const out: LeagueCatalogEntry[] = [];
  for (const [key, val] of Object.entries(payload)) {
    const leagueId = Number(key);
    if (!Number.isInteger(leagueId) || leagueId <= 0 || !isRecord(val))
      continue;
    const rawName = typeof val.n === "string" ? val.n.trim() : "";
    const rawSlug = typeof val.in === "string" ? val.in.trim() : "";
    if (rawName === "" && rawSlug === "") continue;
    out.push({
      leagueId,
      name: rawName !== "" ? rawName : null,
      slug: rawSlug !== "" ? rawSlug : null,
    });
  }
  return out;
}

const PPM_PLACEHOLDER_DECIMAL = 1.001;
const PPM_LINE_KEYED_MARKETS = new Set([5, 6, 7, 8]);

function asPpmDecimal(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > PPM_PLACEHOLDER_DECIMAL
    ? Math.round(value * 1_000_000) / 1_000_000
    : null;
}

function pairPricesLikeBook(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  const sum = 1 / a + 1 / b;
  return sum >= 1.0 && sum <= 1.3;
}

/** Map Spandora market IDs (`5=TOTAL`, `6=SPREAD`, `7/8=TEAM_TOTAL`, `1/2/3=MONEYLINE`) to canonical market kind. */
export function mapPpmMarketKind(marketId: number): PpmMarketKind {
  if (marketId === 6) return "SPREAD";
  if (marketId === 5) return "TOTAL";
  if (marketId === 7 || marketId === 8) return "TEAM_TOTAL";
  if (marketId === 1 || marketId === 2 || marketId === 3) return "MONEYLINE";
  return "OTHER";
}

/** Map Spandora period bucket keys (`m`, `h1`, `h2`, `q1..q4`, `s1..s3`) to canonical period kind. */
export function mapPpmPeriodKind(periodKey: string): string {
  const k = periodKey.trim().toLowerCase();
  if (k === "m" || k === "full" || k === "fg") return "FG";
  if (k === "h1" || k === "1h") return "H1";
  if (k === "h2" || k === "2h") return "H2";
  if (k === "q1" || k === "1q") return "Q1";
  if (k === "q2" || k === "2q") return "Q2";
  if (k === "q3" || k === "3q") return "Q3";
  if (k === "q4" || k === "4q") return "Q4";
  if (k === "p1" || k === "1p") return "1P";
  if (k === "p2" || k === "2p") return "2P";
  if (k === "p3" || k === "3p") return "3P";
  if (/^s\d+$/.test(k)) return k.toUpperCase();
  return k.toUpperCase() || "FG";
}

/**
 * Extract primary reference market lines & decimal odds from an `eventCoefficients.<eID>` document
 * (`doc.c[periodKey][marketId] = { o: { [lineOrSel]: number | [a, b] }, r?: refLine }`).
 * Filters placeholder values (`<= 1.001`) and selects the reference line `r` (or tightest two-sided book).
 */
export function extractMarketLinesFromCoefficients(
  doc: Record<string, unknown>,
): PpmExtractedMarketLine[] {
  const coeffRoot = doc.c;
  if (!isRecord(coeffRoot)) return [];

  const out: PpmExtractedMarketLine[] = [];
  for (const [periodKey, periodMarkets] of Object.entries(coeffRoot)) {
    if (!isRecord(periodMarkets)) continue;
    const periodKind = mapPpmPeriodKind(periodKey);
    for (const [marketKey, node] of Object.entries(periodMarkets)) {
      const marketId = Number(marketKey);
      if (!Number.isInteger(marketId) || marketId <= 0 || !isRecord(node)) {
        continue;
      }
      if (!isRecord(node.o)) continue;
      const lineKeyed = PPM_LINE_KEYED_MARKETS.has(marketId);
      const marketKind = mapPpmMarketKind(marketId);
      const refLine =
        typeof node.r === "number" && Number.isFinite(node.r) ? node.r : null;

      if (lineKeyed) {
        let bestLine: number | null = null;
        let bestOddsA: number | null = null;
        let bestOddsB: number | null = null;
        let bestTwoSided = false;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const [key, raw] of Object.entries(node.o)) {
          const lineNum = Number(key);
          if (!Number.isFinite(lineNum) || key.trim() === "") continue;
          let oddsA: number | null = null;
          let oddsB: number | null = null;
          if (Array.isArray(raw)) {
            oddsA = asPpmDecimal(raw[0]);
            oddsB = asPpmDecimal(raw[1]);
          } else {
            oddsA = asPpmDecimal(raw);
          }
          if (oddsA === null && oddsB === null) continue;
          const twoSided = pairPricesLikeBook(oddsA, oddsB);
          const isRef = refLine !== null && Math.abs(lineNum - refLine) < 1e-6;
          // Prefer exact reference line `r`, then two-sided quotes closest to balanced odds (2.0/2.0).
          const balanceDist =
            oddsA !== null && oddsB !== null ? Math.abs(oddsA - oddsB) : 100;
          const rankScore =
            (isRef ? 0 : 1_000) + (twoSided ? 0 : 500) + balanceDist;
          if (rankScore < bestScore) {
            bestScore = rankScore;
            bestLine = lineNum;
            bestOddsA = oddsA;
            bestOddsB = oddsB;
            bestTwoSided = twoSided;
          }
        }
        if (bestLine !== null) {
          out.push({
            marketId,
            marketKind,
            periodKey,
            periodKind,
            line: bestLine,
            oddsA: bestOddsA,
            oddsB: bestOddsB,
            twoSided: bestTwoSided,
          });
        }
      } else if (marketKind === "MONEYLINE") {
        const entries = Object.entries(node.o);
        let oddsA: number | null = null;
        let oddsB: number | null = null;
        for (const [key, raw] of entries) {
          const dec = Array.isArray(raw)
            ? asPpmDecimal(raw[0])
            : asPpmDecimal(raw);
          if (dec === null) continue;
          if (key === "1" || oddsA === null) {
            if (key === "1") oddsA = dec;
            else if (oddsA === null) oddsA = dec;
            else if (oddsB === null) oddsB = dec;
          } else if (key === "2" || oddsB === null) {
            oddsB = dec;
          }
        }
        if (oddsA !== null || oddsB !== null) {
          out.push({
            marketId,
            marketKind,
            periodKey,
            periodKind,
            line: refLine,
            oddsA,
            oddsB,
            twoSided: pairPricesLikeBook(oddsA, oddsB),
          });
        }
      }
    }
  }
  return out;
}
