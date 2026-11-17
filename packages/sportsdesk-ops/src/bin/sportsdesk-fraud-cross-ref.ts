#!/usr/bin/env bun
// packages/sportsdesk-ops/src/bin/sportsdesk-fraud-cross-ref.ts
/**
 * Live R2-backed pairwise customer wager cross-reference subcommand for `bun x sportsdesk-fraud cross-ref`.
 *
 * Zero local `.json` / `.jsonl` / `.sqlite` / `.dodbin` reads: hydrates contiguous SoA
 * `PairwiseWagerColumnStore` slices directly from `sportsdesk-ops-reports` R2 manifests
 * (`manifests/wagers-by-state/latest` and `manifests/syndicate-rings/latest`) via `Bun.S3Client`.
 */

import { parseArgs } from "node:util";
import { portalIso } from "../../../../lib/bet_flags.ts";
import {
  LIVE_WAGER_TYPE_CODE3,
  SOURCE_BRIDGE_IDS,
  asLineHundredths,
  encodePairwiseSoAChunk,
  evaluateColumnarPairwiseCrossRef,
  hydratePairwiseColumnStoreFromSoAChunk,
  packSubSportComboKey15,
  parseDualSurfaceBetGroupToken,
  parseFixedPointDecimalToBigInt,
  PairwiseWagerColumnStore,
  type PairwiseCrossRefResult,
  type PairwiseOverlapRecord,
  type SourceBridgeId2,
} from "../../../../src/lib/customer_pairwise_cross_ref.ts";
import {
  SYNDICATE_RINGS_MANIFEST_KEY,
  type SyndicateRingsSnapshotManifest,
} from "../../../../src/lib/syndicate_adjacency_rollup.ts";

export const R2_BUCKET = "sportsdesk-ops-reports" as const;
export const WAGERS_BY_STATE_MANIFEST_KEY =
  "manifests/wagers-by-state/latest" as const;
export const LIVE_WAGERS_R2_KEY = "live-wagers/latest.json" as const;
export const WAGERS_BY_STATE_SNAPSHOT_KEY =
  "wagers-by-state/latest.json" as const;
export { SYNDICATE_RINGS_MANIFEST_KEY };

const RETIRED_FALLBACK_ENV_KEYS = [
  "DOD6_SPINE_PATH",
  "DOD_SPINE_PATH",
  "F402_BETS_JSONL_PATH",
  "DOD_SQLITE_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

const FORBIDDEN_LOCAL_EXT_RE = /\.(?:json|jsonl|sqlite|dodbin)(?:$|\?)/i;

export interface PairwiseR2FileLike {
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

export interface PairwiseR2Reader {
  file(key: string): PairwiseR2FileLike;
}

export interface WagersByStateR2Manifest {
  readonly domain?: string;
  readonly sink_id?: string;
  readonly r2_bucket?: string;
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly watermark_cursor: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly chunk_key: string;
  readonly circuit_state: string;
  readonly unresolved_gap_cents?: string;
}

export interface PairwiseCrossRefJsonAnalysis {
  readonly customerA: string;
  readonly customerB: string;
  readonly bridgeFilter: SourceBridgeId2 | "ALL";
  readonly totalWagersA: number;
  readonly totalWagersB: number;
  readonly catalogDistinctEvents: number;
  readonly distinctEventsA: number;
  readonly distinctEventsB: number;
  readonly sharedEventsCount: number;
  readonly sameSideCount: number;
  readonly oppositeSideCount: number;
  readonly differentMarketCount: number;
  readonly suppressedBroadcastSurgeCount: number;
  readonly liveBotFollowsAtoB: number;
  readonly liveBotFollowsBtoA: number;
  readonly pregameApiBotFollowsAtoB: number;
  readonly pregameApiBotFollowsBtoA: number;
  readonly pregameFollowsAtoB: number;
  readonly pregameFollowsBtoA: number;
  readonly avgSameSideLagMsU32: number;
  readonly minSameSideLagMsU32: number;
  readonly customerALeadShareBps: number;
  readonly bAbsentParticipationBps: number;
  readonly bPresentParticipationBps: number;
  readonly liftRatioBps: number;
  readonly inferredRoleB: PairwiseCrossRefResult["inferredRoleB"];
  readonly overlaps: readonly PairwiseOverlapRecord[];
}

export interface PairwiseCrossRefR2Payload {
  readonly schemaVersion: 1;
  readonly command: "cross-ref";
  readonly domain: string;
  readonly sink_id: string;
  readonly r2_bucket: string;
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly watermark_cursor: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly circuit_state: string;
  readonly unresolved_gap_cents: string;
  readonly manifests: {
    readonly wagersByState: {
      readonly key: typeof WAGERS_BY_STATE_MANIFEST_KEY;
      readonly generation_u32: number;
      readonly merkle_root_sha256: string;
      readonly watermark_cursor: string;
      readonly data_window_max_epoch_ms: number;
      readonly r2_published_at_epoch_ms: number;
      readonly chunk_key: string;
      readonly circuit_state: string;
    };
    readonly syndicateRings: {
      readonly key: typeof SYNDICATE_RINGS_MANIFEST_KEY;
      readonly domain: string;
      readonly generation_u32: number;
      readonly spine_generation_u32: number;
      readonly merkle_root_sha256: string;
      readonly r2_published_at_epoch_ms: number;
      readonly active_edge_count_u32: number;
      readonly ring_count_u32: number;
    };
  };
  readonly hydratedRows: number;
  readonly analysis: PairwiseCrossRefJsonAnalysis;
}

export class PairwiseCrossRefError extends Error {
  public readonly exitCode: number;
  public readonly errorCode: string;

  constructor(
    errorCode: string,
    message: string,
    exitCode: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PairwiseCrossRefError";
    this.errorCode = errorCode;
    this.exitCode = exitCode;
  }
}

export const CROSS_REF_HELP = `
sportsdesk-fraud cross-ref — live R2-backed columnar pairwise customer wager cross-reference

Usage:
  bun x sportsdesk-fraud cross-ref <customerA> <customerB> [options]

Options:
  --bridge <all|f402|gslive>   Filter evaluation to one bridge or all bridges (default: all)
  --max-overlaps <n>           Maximum sample overlaps emitted in --json output (default: 16)
  -j, --json                   Emit single JSON object with R2 lineage envelope on stdout
  -h, --help                   Show this help

Governance:
  Hydrates contiguous SoA chunks via Bun.S3Client from sportsdesk-ops-reports R2 manifests:
    - ${WAGERS_BY_STATE_MANIFEST_KEY}
    - ${SYNDICATE_RINGS_MANIFEST_KEY}
  Local file flags (--input, --file) and .json/.jsonl/.sqlite/.dodbin paths fail closed
  with ERR_OPS_LOCAL_JSON_FORBIDDEN (exit 78).
`.trim();

/**
 * Live runtime preflight for pairwise cross-reference CLI.
 * Rejects retired env keys (exit 78), token bleed (exit 77), local file flags/extensions (exit 78),
 * and missing R2 credentials (exit 65).
 */
export function assertPairwiseCrossRefLivePreflight(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const key of RETIRED_FALLBACK_ENV_KEYS) {
    if (env[key]) {
      throw new PairwiseCrossRefError(
        "ERR_DOD_LEGACY_FALLBACK_REMOVED",
        `ERR_DOD_LEGACY_FALLBACK_REMOVED: ${key}`,
        78,
      );
    }
  }
  if (env.CLOUDFLARE_R2_API_TOKEN && env.CLOUDFLARE_API_TOKEN) {
    throw new PairwiseCrossRefError(
      "ERR_CF_TOKEN_BLEED_10000",
      "ERR_CF_TOKEN_BLEED_10000",
      77,
    );
  }
  for (const token of argv) {
    if (
      token === "--input" ||
      token.startsWith("--input=") ||
      token === "--file" ||
      token.startsWith("--file=") ||
      FORBIDDEN_LOCAL_EXT_RE.test(token)
    ) {
      throw new PairwiseCrossRefError(
        "ERR_OPS_LOCAL_JSON_FORBIDDEN",
        `ERR_OPS_LOCAL_JSON_FORBIDDEN: local file input is forbidden (${token})`,
        78,
      );
    }
  }
  const endpoint = resolveR2Endpoint(env);
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !endpoint) {
    throw new PairwiseCrossRefError(
      "ERR_CF_R2_CREDENTIALS_MISSING",
      "ERR_CF_R2_CREDENTIALS_MISSING",
      65,
    );
  }
}

export function resolveR2Endpoint(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (env.R2_ENDPOINT && env.R2_ENDPOINT.trim().length > 0) {
    return env.R2_ENDPOINT.trim();
  }
  if (
    env.CLOUDFLARE_ACCOUNT_ID &&
    env.CLOUDFLARE_ACCOUNT_ID.trim().length > 0
  ) {
    return `https://${env.CLOUDFLARE_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`;
  }
  return undefined;
}

function createR2ReaderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): PairwiseR2Reader {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const endpoint = resolveR2Endpoint(env);
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new PairwiseCrossRefError(
      "ERR_CF_R2_CREDENTIALS_MISSING",
      "ERR_CF_R2_CREDENTIALS_MISSING",
      65,
    );
  }
  return new Bun.S3Client({
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucket: R2_BUCKET,
  });
}

async function readR2JsonManifest<T>(
  r2: PairwiseR2Reader,
  key: string,
): Promise<T> {
  let raw: string;
  try {
    raw = await r2.file(key).text();
  } catch (cause) {
    throw new PairwiseCrossRefError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${key} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      65,
      cause,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new PairwiseCrossRefError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${key} returned invalid JSON`,
      65,
      cause,
    );
  }
}

async function readR2BinaryChunk(
  r2: PairwiseR2Reader,
  key: string,
): Promise<Uint8Array> {
  if (FORBIDDEN_LOCAL_EXT_RE.test(key)) {
    throw new PairwiseCrossRefError(
      "ERR_OPS_LOCAL_JSON_FORBIDDEN",
      `ERR_OPS_LOCAL_JSON_FORBIDDEN: chunk_key cannot reference local JSON/SQLite (${key})`,
      78,
    );
  }
  try {
    return await r2.file(key).bytes();
  } catch (cause) {
    throw new PairwiseCrossRefError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${key} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      65,
      cause,
    );
  }
}

function projectJsonAnalysis(
  result: PairwiseCrossRefResult,
): PairwiseCrossRefJsonAnalysis {
  return {
    customerA: result.customerA,
    customerB: result.customerB,
    bridgeFilter: result.bridgeFilter,
    totalWagersA: result.totalWagersA,
    totalWagersB: result.totalWagersB,
    catalogDistinctEvents: result.catalogDistinctEvents,
    distinctEventsA: result.distinctEventsA,
    distinctEventsB: result.distinctEventsB,
    sharedEventsCount: result.sharedEventsCount,
    sameSideCount: result.sameSideCount,
    oppositeSideCount: result.oppositeSideCount,
    differentMarketCount: result.differentMarketCount,
    suppressedBroadcastSurgeCount: result.suppressedBroadcastSurgeCount,
    liveBotFollowsAtoB: result.liveBotFollowsAtoB,
    liveBotFollowsBtoA: result.liveBotFollowsBtoA,
    pregameApiBotFollowsAtoB: result.pregameApiBotFollowsAtoB,
    pregameApiBotFollowsBtoA: result.pregameApiBotFollowsBtoA,
    pregameFollowsAtoB: result.pregameFollowsAtoB,
    pregameFollowsBtoA: result.pregameFollowsBtoA,
    avgSameSideLagMsU32: result.avgSameSideLagMsU32,
    minSameSideLagMsU32: result.minSameSideLagMsU32,
    customerALeadShareBps: result.customerALeadShareBps,
    bAbsentParticipationBps: result.bAbsentParticipationBps,
    bPresentParticipationBps: result.bPresentParticipationBps,
    liftRatioBps: result.liftRatioBps,
    inferredRoleB: result.inferredRoleB,
    overlaps: result.overlaps,
  };
}

function isR2NoSuchKeyError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return /NoSuchKey|404|does not exist/i.test(String(err));
  }
  const obj = err as {
    readonly code?: unknown;
    readonly name?: unknown;
    readonly status?: unknown;
    readonly message?: unknown;
    readonly cause?: unknown;
  };
  if (obj.status === 404) return true;
  if (typeof obj.code === "string" && /NoSuchKey|ENOENT|404/i.test(obj.code)) {
    return true;
  }
  if (
    typeof obj.message === "string" &&
    /NoSuchKey|404|does not exist/i.test(obj.message)
  ) {
    return true;
  }
  return obj.cause !== undefined ? isR2NoSuchKeyError(obj.cause) : false;
}

async function tryReadR2JsonManifest<T>(
  r2: PairwiseR2Reader,
  key: string,
): Promise<T | null> {
  try {
    return await readR2JsonManifest<T>(r2, key);
  } catch (err) {
    if (isR2NoSuchKeyError(err)) {
      return null;
    }
    throw err;
  }
}

interface RawLiveWagerRow {
  readonly WagerNumber?: unknown;
  readonly CustomerID?: unknown;
  readonly Login?: unknown;
  readonly AmountWagered?: unknown;
  readonly InsertDateTime?: unknown;
  readonly TicketWriter?: unknown;
  readonly ShortDesc?: unknown;
}

interface LiveWagersSnapshotDocument {
  readonly observedAt?: unknown;
  readonly LIST?: readonly RawLiveWagerRow[];
}

interface WagersByStateSnapshotDocument {
  readonly generatedAt?: unknown;
  readonly capturedAt?: unknown;
  readonly sourceSha256?: unknown;
}

const SPORT_CODE6_MAP: ReadonlyArray<readonly [RegExp, number]> = [
  [/football|nfl|cfb|ncaaf/i, 1],
  [/baseball|mlb|ncaa\s*baseball/i, 2],
  [/basketball|nba|cbb|ncaab|wnba/i, 3],
  [/hockey|nhl/i, 4],
  [/soccer|mls|epl|uefa|champions/i, 5],
];

function inferSportCode6(text: string): number {
  for (const [pattern, code] of SPORT_CODE6_MAP) {
    if (pattern.test(text)) return code;
  }
  return 1;
}

function inferPeriodCode4(segment: string): number {
  if (/\b(?:1st\s+Half|1H)\b/i.test(segment)) return 1;
  if (/\b(?:2nd\s+Half|2H)\b/i.test(segment)) return 2;
  if (/\b(?:1st\s+Quarter|1Q)\b/i.test(segment)) return 3;
  if (/\b(?:2nd\s+Quarter|2Q)\b/i.test(segment)) return 4;
  if (/\b(?:3rd\s+Quarter|3Q)\b/i.test(segment)) return 5;
  if (/\b(?:4th\s+Quarter|4Q)\b/i.test(segment)) return 6;
  return 0;
}

function parseInsertDateTimeEpochMs(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
  }
  const iso = portalIso(raw);
  if (iso === null) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseSafeDecimalHundredths(raw: string): number {
  const cleaned = raw.trim().replaceAll("\u00BD", ".5").replaceAll(",", "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(cleaned)) {
    return 0;
  }
  const scaled = parseFixedPointDecimalToBigInt(cleaned, 2);
  const absLimit = 2_000_000_000n;
  if (scaled > absLimit || scaled < -absLimit) return 0;
  return Number(scaled);
}

function parseLegAttributes(
  rawRot: number,
  segment: string,
  ticketPrefix: string,
  prevContext: string,
): {
  readonly subSportCode6: number;
  readonly wagerTypeCode3: number;
  readonly periodCode4: number;
  readonly marketKindCode2: number;
  readonly sideCode2: number;
  readonly lineHundredths: number;
  readonly oddsAmerican: number;
} {
  const headOnly = segment.split(/\s+-\s+(?:buying|For)\b/i)[0] ?? segment;
  const subSportCode6 = inferSportCode6(
    `${prevContext} ${segment} ${ticketPrefix}`,
  );
  const isLive =
    /^L[:.]/i.test(ticketPrefix) || (rawRot >= 9000 && rawRot <= 9999);
  const wagerTypeCode3 = isLive ? LIVE_WAGER_TYPE_CODE3 : 0;
  const periodCode4 = inferPeriodCode4(segment);

  const totalMatch =
    /\b([OU])\s*([0-9]+(?:\.[0-9]+|\u00BD)?)\b/i.exec(headOnly) ??
    /\b(Over|Under)\s*([0-9]+(?:\.[0-9]+|\u00BD)?)\b/i.exec(headOnly);
  if (totalMatch) {
    const marketKindCode2 = 1;
    const sideCode2 = totalMatch[1]!.toUpperCase().startsWith("U") ? 1 : 0;
    const lineHundredths = parseSafeDecimalHundredths(totalMatch[2]!);
    const tailAfterTotal = headOnly.slice(
      (totalMatch.index ?? 0) + totalMatch[0].length,
    );
    const oddsMatch = /[+-]\d{3,4}/.exec(tailAfterTotal);
    const oddsAmerican = oddsMatch ? Math.trunc(Number(oddsMatch[0])) : -110;
    return {
      subSportCode6,
      wagerTypeCode3,
      periodCode4,
      marketKindCode2,
      sideCode2,
      lineHundredths,
      oddsAmerican,
    };
  }

  const numericTokens: string[] = [];
  const tokRe = /(?:^|\s)([+-]?\d+(?:\.\d+)?\u00BD?|[+-]?\u00BD)(?=$|[\s,])/g;
  let tokMatch: RegExpExecArray | null;
  while ((tokMatch = tokRe.exec(headOnly)) !== null) {
    numericTokens.push(tokMatch[1]!);
  }
  const lastTok = numericTokens[numericTokens.length - 1];
  const prevTok =
    numericTokens.length >= 2
      ? numericTokens[numericTokens.length - 2]
      : undefined;

  const explicitMl =
    /^M[:.]/i.test(ticketPrefix) || /\bML\b|Money\s*Line/i.test(segment);
  if (
    explicitMl ||
    (numericTokens.length === 1 &&
      lastTok !== undefined &&
      Math.abs(parseSafeDecimalHundredths(lastTok)) >= 10_000)
  ) {
    const oddsVal = lastTok
      ? Math.trunc(parseSafeDecimalHundredths(lastTok) / 100)
      : -110;
    return {
      subSportCode6,
      wagerTypeCode3,
      periodCode4,
      marketKindCode2: 2,
      sideCode2: rawRot & 1 ? 0 : 1,
      lineHundredths: 0,
      oddsAmerican: oddsVal,
    };
  }

  if (prevTok !== undefined && lastTok !== undefined) {
    return {
      subSportCode6,
      wagerTypeCode3,
      periodCode4,
      marketKindCode2: 0,
      sideCode2: rawRot & 1 ? 0 : 1,
      lineHundredths: parseSafeDecimalHundredths(prevTok),
      oddsAmerican: Math.trunc(parseSafeDecimalHundredths(lastTok) / 100),
    };
  }

  if (lastTok !== undefined) {
    return {
      subSportCode6,
      wagerTypeCode3,
      periodCode4,
      marketKindCode2: 0,
      sideCode2: rawRot & 1 ? 0 : 1,
      lineHundredths: parseSafeDecimalHundredths(lastTok),
      oddsAmerican: -110,
    };
  }

  return {
    subSportCode6,
    wagerTypeCode3,
    periodCode4,
    marketKindCode2: 0,
    sideCode2: rawRot & 1 ? 0 : 1,
    lineHundredths: 0,
    oddsAmerican: -110,
  };
}

async function hydrateLiveWagersSnapshotFromR2(r2: PairwiseR2Reader): Promise<{
  readonly store: PairwiseWagerColumnStore;
  readonly manifest: WagersByStateR2Manifest;
}> {
  const [liveWagersDoc, wagersByStateDoc] = await Promise.all([
    readR2JsonManifest<LiveWagersSnapshotDocument>(r2, LIVE_WAGERS_R2_KEY),
    tryReadR2JsonManifest<WagersByStateSnapshotDocument>(
      r2,
      WAGERS_BY_STATE_SNAPSHOT_KEY,
    ),
  ]);

  const rows = Array.isArray(liveWagersDoc.LIST) ? liveWagersDoc.LIST : [];
  let estimatedLegs = 0;
  for (const row of rows) {
    const desc = String(row.ShortDesc ?? "");
    const matches = desc.match(/#\d{3,6}\b/g);
    if (matches) estimatedLegs += matches.length;
  }

  const store = new PairwiseWagerColumnStore(Math.max(1, estimatedLegs));
  const observedMs =
    typeof liveWagersDoc.observedAt === "string"
      ? Date.parse(liveWagersDoc.observedAt)
      : Date.now();
  const fallbackEpochMs = Number.isFinite(observedMs) ? observedMs : Date.now();
  let maxEpochMs = 0;

  for (const row of rows) {
    const writer = String(row.TicketWriter ?? "")
      .trim()
      .toUpperCase();
    if (writer === "ALERT") {
      continue;
    }

    const rawCustomer = String(row.CustomerID ?? row.Login ?? "").trim();
    if (rawCustomer.length === 0) continue;

    const descRaw = String(row.ShortDesc ?? "").replaceAll("&#189;", "\u00BD");
    const legRe = /#(\d{3,6})\b([^#]*)/g;
    const prefix = descRaw.slice(0, 32);
    const bridgeId =
      writer === "GSLIVE"
        ? SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C
        : SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB;

    const wagerGroup64 = /^M\.G\d+/i.test(descRaw)
      ? parseDualSurfaceBetGroupToken(descRaw.split(/\s+/)[0] ?? "")
      : typeof row.WagerNumber === "number" && Number.isFinite(row.WagerNumber)
        ? BigInt(Math.trunc(row.WagerNumber))
        : 0n;

    const placedMs =
      parseInsertDateTimeEpochMs(row.InsertDateTime) || fallbackEpochMs;
    if (placedMs > maxEpochMs) maxEpochMs = placedMs;

    const stakeNum =
      typeof row.AmountWagered === "number" &&
      Number.isFinite(row.AmountWagered)
        ? BigInt(Math.trunc(row.AmountWagered))
        : 0n;

    let match: RegExpExecArray | null;
    while ((match = legRe.exec(descRaw)) !== null) {
      const rawRot = Number(match[1]);
      if (!Number.isInteger(rawRot) || rawRot < 0 || rawRot > 0x0fffff) {
        continue;
      }
      const prevContext = descRaw.slice(
        Math.max(0, match.index - 24),
        match.index,
      );
      const attrs = parseLegAttributes(
        rawRot,
        match[2] ?? "",
        prefix,
        prevContext,
      );
      const key15 = packSubSportComboKey15(
        attrs.subSportCode6,
        attrs.wagerTypeCode3,
        attrs.periodCode4,
        attrs.marketKindCode2,
      );
      store.appendLeg(
        rawCustomer,
        wagerGroup64,
        rawRot,
        key15,
        asLineHundredths(attrs.lineHundredths),
        attrs.oddsAmerican,
        stakeNum,
        placedMs,
        bridgeId,
        attrs.sideCode2,
      );
    }
  }

  const chunkBytes = encodePairwiseSoAChunk(store);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(chunkBytes);
  const merkleRootSha256 = hasher.digest("hex");

  const publishedIso =
    typeof wagersByStateDoc?.generatedAt === "string"
      ? wagersByStateDoc.generatedAt
      : typeof liveWagersDoc.observedAt === "string"
        ? liveWagersDoc.observedAt
        : "";
  const publishedMs = publishedIso ? Date.parse(publishedIso) : fallbackEpochMs;
  const sourceShaPrefix =
    typeof wagersByStateDoc?.sourceSha256 === "string" &&
    wagersByStateDoc.sourceSha256.length >= 16
      ? wagersByStateDoc.sourceSha256.slice(0, 16)
      : merkleRootSha256.slice(0, 16);

  return {
    store,
    manifest: {
      domain: "[Ops & Governance]",
      sink_id: "wagers-by-state",
      r2_bucket: R2_BUCKET,
      generation_u32: 0,
      merkle_root_sha256: merkleRootSha256,
      watermark_cursor: `${sourceShaPrefix}:${store.length}`,
      data_window_max_epoch_ms: maxEpochMs > 0 ? maxEpochMs : fallbackEpochMs,
      r2_published_at_epoch_ms: Number.isFinite(publishedMs)
        ? publishedMs
        : fallbackEpochMs,
      chunk_key: LIVE_WAGERS_R2_KEY,
      circuit_state: "CLOSED",
      unresolved_gap_cents: "0",
    },
  };
}

export async function executePairwiseCrossRefFromR2(params: {
  readonly r2: PairwiseR2Reader;
  readonly customerA: string;
  readonly customerB: string;
  readonly bridgeFilter?: SourceBridgeId2 | "ALL";
  readonly maxSampleOverlaps?: number;
}): Promise<PairwiseCrossRefR2Payload> {
  const [manifestWagers, manifestRings] = await Promise.all([
    tryReadR2JsonManifest<WagersByStateR2Manifest>(
      params.r2,
      WAGERS_BY_STATE_MANIFEST_KEY,
    ),
    tryReadR2JsonManifest<SyndicateRingsSnapshotManifest>(
      params.r2,
      SYNDICATE_RINGS_MANIFEST_KEY,
    ),
  ]);

  let wagersManifest: WagersByStateR2Manifest;
  let store: PairwiseWagerColumnStore;
  let hydratedRows: number;

  if (manifestWagers !== null) {
    wagersManifest = manifestWagers;
    if (
      typeof wagersManifest.chunk_key !== "string" ||
      wagersManifest.chunk_key.trim().length === 0
    ) {
      throw new PairwiseCrossRefError(
        "ERR_R2_SINK_BACKPRESSURE",
        `ERR_R2_SINK_BACKPRESSURE: ${WAGERS_BY_STATE_MANIFEST_KEY} missing chunk_key`,
        65,
      );
    }

    const rawGap = String(wagersManifest.unresolved_gap_cents ?? "0").trim();
    let parsedGapCents: bigint;
    try {
      parsedGapCents = rawGap.length > 0 ? BigInt(rawGap) : 1n;
    } catch (cause) {
      throw new PairwiseCrossRefError(
        "ERR_OPS_RECONCILIATION_GAP",
        `ERR_OPS_RECONCILIATION_GAP: invalid unresolved_gap_cents (${rawGap})`,
        65,
        cause,
      );
    }
    if (parsedGapCents !== 0n) {
      throw new PairwiseCrossRefError(
        "ERR_OPS_RECONCILIATION_GAP",
        `ERR_OPS_RECONCILIATION_GAP: unresolved_gap_cents=${parsedGapCents.toString()}`,
        65,
      );
    }

    const chunkBytes = await readR2BinaryChunk(
      params.r2,
      wagersManifest.chunk_key,
    );
    if (chunkBytes.byteLength < 16) {
      throw new PairwiseCrossRefError(
        "ERR_SOA_BINARY_TRUNCATED",
        "ERR_SOA_BINARY_TRUNCATED: R2 SoA chunk smaller than 16-byte header",
        65,
      );
    }
    const declaredRowCount = new DataView(
      chunkBytes.buffer,
      chunkBytes.byteOffset,
      16,
    ).getUint32(8, true);

    store = new PairwiseWagerColumnStore(Math.max(1, declaredRowCount));
    try {
      hydratedRows = hydratePairwiseColumnStoreFromSoAChunk(
        chunkBytes,
        "ALL",
        store,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const exitCode = message.includes("ERR_BRIDGE_CHANNEL_CONTAMINATION")
        ? 70
        : 65;
      throw new PairwiseCrossRefError(
        message.split(":")[0] ?? "ERR_SOA_BINARY_TRUNCATED",
        message,
        exitCode,
        cause,
      );
    }
  } else {
    const fallback = await hydrateLiveWagersSnapshotFromR2(params.r2);
    wagersManifest = fallback.manifest;
    store = fallback.store;
    hydratedRows = store.length;
  }

  const ringsManifest: SyndicateRingsSnapshotManifest = manifestRings ?? {
    domain: "[DOD Spine]",
    r2_bucket: R2_BUCKET,
    manifest_key: SYNDICATE_RINGS_MANIFEST_KEY,
    generation_u32: 0,
    spine_generation_u32: 0,
    merkle_root_sha256: "0".repeat(64),
    r2_published_at_epoch_ms: 0,
    active_edge_count_u32: 0,
    ring_count_u32: 0,
    rings: [],
  };

  const crossRef = evaluateColumnarPairwiseCrossRef(
    store,
    params.customerA,
    params.customerB,
    {
      bridgeFilter: params.bridgeFilter ?? "ALL",
      maxSampleOverlaps: params.maxSampleOverlaps ?? 16,
    },
  );

  const generationU32 = wagersManifest.generation_u32 >>> 0;
  return {
    schemaVersion: 1,
    command: "cross-ref",
    domain: wagersManifest.domain ?? "[Ops & Governance]",
    sink_id: wagersManifest.sink_id ?? "wagers-by-state",
    r2_bucket: wagersManifest.r2_bucket ?? R2_BUCKET,
    generation_u32: generationU32,
    merkle_root_sha256: wagersManifest.merkle_root_sha256,
    watermark_cursor: wagersManifest.watermark_cursor,
    data_window_max_epoch_ms: wagersManifest.data_window_max_epoch_ms,
    r2_published_at_epoch_ms: wagersManifest.r2_published_at_epoch_ms,
    circuit_state: wagersManifest.circuit_state ?? "CLOSED",
    unresolved_gap_cents: "0",
    manifests: {
      wagersByState: {
        key: WAGERS_BY_STATE_MANIFEST_KEY,
        generation_u32: generationU32,
        merkle_root_sha256: wagersManifest.merkle_root_sha256,
        watermark_cursor: wagersManifest.watermark_cursor,
        data_window_max_epoch_ms: wagersManifest.data_window_max_epoch_ms,
        r2_published_at_epoch_ms: wagersManifest.r2_published_at_epoch_ms,
        chunk_key: wagersManifest.chunk_key,
        circuit_state: wagersManifest.circuit_state ?? "CLOSED",
      },
      syndicateRings: {
        key: SYNDICATE_RINGS_MANIFEST_KEY,
        domain: ringsManifest.domain ?? "[DOD Spine]",
        generation_u32: ringsManifest.generation_u32 >>> 0,
        spine_generation_u32: ringsManifest.spine_generation_u32 >>> 0,
        merkle_root_sha256: ringsManifest.merkle_root_sha256,
        r2_published_at_epoch_ms: ringsManifest.r2_published_at_epoch_ms,
        active_edge_count_u32: ringsManifest.active_edge_count_u32 >>> 0,
        ring_count_u32: ringsManifest.ring_count_u32 >>> 0,
      },
    },
    hydratedRows,
    analysis: projectJsonAnalysis(crossRef),
  };
}

function parseBridgeFilter(raw: string | undefined): SourceBridgeId2 | "ALL" {
  if (raw === undefined || raw.toLowerCase() === "all") return "ALL";
  const normalized = raw.toLowerCase();
  if (normalized === "f402") return SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB;
  if (normalized === "gslive") return SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C;
  throw new PairwiseCrossRefError(
    "usage_error",
    `cross-ref: invalid --bridge value "${raw}" (expected all|f402|gslive)`,
    2,
  );
}

export function formatPairwiseCrossRefHumanReport(
  payload: PairwiseCrossRefR2Payload,
): string {
  const { analysis, manifests } = payload;
  const lines = [
    `[Pairwise Cross-Ref] ${analysis.customerA} vs ${analysis.customerB} (bridge=${String(analysis.bridgeFilter)}, catalogEvents=${analysis.catalogDistinctEvents})`,
    `  R2 Lineage                 : bucket=${payload.r2_bucket} gen=${payload.generation_u32} circuit=${payload.circuit_state} watermark=${payload.watermark_cursor}`,
    `  Manifests                  : wagers=${manifests.wagersByState.key}@gen${manifests.wagersByState.generation_u32} rings=${manifests.syndicateRings.key}@gen${manifests.syndicateRings.generation_u32} (rings=${manifests.syndicateRings.ring_count_u32})`,
    `  Wagers (A / B)             : ${analysis.totalWagersA} / ${analysis.totalWagersB} (hydrated=${payload.hydratedRows})`,
    `  Shared Canonical Events    : ${analysis.sharedEventsCount} (A=${analysis.distinctEventsA}, B=${analysis.distinctEventsB})`,
    `  Overlaps (Same / Opp / Mkt): ${analysis.sameSideCount} / ${analysis.oppositeSideCount} / ${analysis.differentMarketCount}`,
    `  Live <=1.5s Follows (A->B) : ${analysis.liveBotFollowsAtoB} (B->A: ${analysis.liveBotFollowsBtoA}, Surge Suppressed: ${analysis.suppressedBroadcastSurgeCount})`,
    `  Pregame Follows (A->B)     : ${analysis.pregameFollowsAtoB} [API<=5s: ${analysis.pregameApiBotFollowsAtoB}] (B->A: ${analysis.pregameFollowsBtoA} [API<=5s: ${analysis.pregameApiBotFollowsBtoA}])`,
    `  Same-Side Lag (Avg / Min)  : ${analysis.avgSameSideLagMsU32}ms / ${analysis.minSameSideLagMsU32}ms`,
    `  Customer A Lead Share      : ${analysis.customerALeadShareBps} bps`,
    `  Participation Lift         : ${analysis.bPresentParticipationBps} bps (A present) vs ${analysis.bAbsentParticipationBps} bps (A absent) -> ${analysis.liftRatioBps >= 0 ? "+" : ""}${analysis.liftRatioBps} bps [${analysis.inferredRoleB}]`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function runPairwiseCrossRefCli(
  argv: readonly string[] = Bun.argv.slice(2),
  options?: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly r2?: PairwiseR2Reader;
    readonly jsonDefault?: boolean;
  },
): Promise<PairwiseCrossRefR2Payload | null> {
  if (argv.includes("-h") || argv.includes("--help")) {
    // Reject forbidden local flags even alongside --help.
    for (const token of argv) {
      if (
        token === "--input" ||
        token.startsWith("--input=") ||
        token === "--file" ||
        token.startsWith("--file=") ||
        FORBIDDEN_LOCAL_EXT_RE.test(token)
      ) {
        throw new PairwiseCrossRefError(
          "ERR_OPS_LOCAL_JSON_FORBIDDEN",
          `ERR_OPS_LOCAL_JSON_FORBIDDEN: local file input is forbidden (${token})`,
          78,
        );
      }
    }
    process.stdout.write(`${CROSS_REF_HELP}\n`);
    return null;
  }

  const env = options?.env ?? Bun.env;
  assertPairwiseCrossRefLivePreflight(argv, env);

  let parsed: ReturnType<
    typeof parseArgs<{
      readonly options: {
        readonly bridge: { readonly type: "string" };
        readonly "max-overlaps": { readonly type: "string" };
        readonly json: { readonly type: "boolean"; readonly short: "j" };
        readonly help: { readonly type: "boolean"; readonly short: "h" };
      };
      readonly strict: true;
      readonly allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        bridge: { type: "string" },
        "max-overlaps": { type: "string" },
        json: { type: "boolean", short: "j", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (cause) {
    throw new PairwiseCrossRefError(
      "usage_error",
      `cross-ref: ${cause instanceof Error ? cause.message : String(cause)}`,
      2,
      cause,
    );
  }

  const [customerA, customerB, ...extraPositionals] = parsed.positionals;
  if (!customerA || !customerB) {
    throw new PairwiseCrossRefError(
      "usage_error",
      "cross-ref: requires <customerA> <customerB>",
      2,
    );
  }
  if (extraPositionals.length > 0) {
    throw new PairwiseCrossRefError(
      "usage_error",
      `cross-ref: unexpected argument "${extraPositionals[0]}"`,
      2,
    );
  }

  const bridgeFilter = parseBridgeFilter(parsed.values.bridge);
  const rawMaxOverlaps = parsed.values["max-overlaps"];
  const maxSampleOverlaps =
    rawMaxOverlaps === undefined ? 16 : Number(rawMaxOverlaps);
  if (
    !Number.isInteger(maxSampleOverlaps) ||
    maxSampleOverlaps < 0 ||
    maxSampleOverlaps > 1024
  ) {
    throw new PairwiseCrossRefError(
      "usage_error",
      `cross-ref: --max-overlaps must be an integer in [0, 1024]`,
      2,
    );
  }

  const r2 = options?.r2 ?? createR2ReaderFromEnv(env);
  const payload = await executePairwiseCrossRefFromR2({
    r2,
    customerA,
    customerB,
    bridgeFilter,
    maxSampleOverlaps,
  });

  const emitJson = Boolean(parsed.values.json || options?.jsonDefault);
  if (emitJson) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(formatPairwiseCrossRefHumanReport(payload));
  }
  return payload;
}

if (import.meta.main) {
  runPairwiseCrossRefCli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    if (err instanceof PairwiseCrossRefError) {
      process.exit(err.exitCode);
    }
    const exitCode =
      message.includes("ERR_DOD_LEGACY_FALLBACK_REMOVED") ||
      message.includes("ERR_OPS_LOCAL_JSON_FORBIDDEN")
        ? 78
        : message.includes("ERR_CF_TOKEN_BLEED_10000")
          ? 77
          : message.includes("ERR_DOD_CSR_CONSERVATION_BREACH") ||
              message.includes("ERR_BRIDGE_CHANNEL_CONTAMINATION")
            ? 70
            : 65;
    process.exit(exitCode);
  });
}
