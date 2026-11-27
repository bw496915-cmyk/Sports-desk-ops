/**
 * Content-addressed R2 NDJSON chunk + strong-ETag CAS manifest flusher for `ppm-live-ticks`.
 *
 * Invariants:
 *  - Chunks are written once to `ppm-live-ticks/chunks/<deskDate>/<sha256>.ndjson` using
 *    `onlyIf: { etagDoesNotMatch: "*" }` (`If-None-Match: *`), so duplicate flushes never clobber.
 *  - Pointer manifest `manifests/ppm-live-ticks/latest` strips any weak `^W/` prefix + quotes from
 *    the current ETag and performs conditional CAS (`etagMatches` / `etagDoesNotMatch: "*"`).
 *  - Strictly separates `data_window_max_epoch_ms` (max tick `ts_ms`) from
 *    `r2_published_at_epoch_ms` (wall-clock publish time).
 *  - Stamps the locked 6-axis SportsDesk taxonomy (`office`, `supplier`, `partnerId`, `endpoint`,
 *    `provenance`) on every chunk header and manifest.
 *
 * @file workers/ppm-live-ticks/src/r2_cas_flush.ts
 */

import { defaultWallClock, deskDateUtc, type WallClock } from "./clocks.ts";
import { sha256Hex } from "./spandora_wire.ts";

export const PPM_TICKS_MANIFEST_KEY = "manifests/ppm-live-ticks/latest";

export type PpmTickRecord = {
  readonly event_id: number;
  readonly ts_ms: number;
  readonly sport_id: number;
  readonly league_id: number;
  readonly home_score: number | null;
  readonly away_score: number | null;
  readonly period: number | null;
  readonly clock_sec: number | null;
  readonly is_blocked: number;
  readonly score_changed: number;
  readonly source_topic: string;
  readonly raw_sha256: string;
};

export type PpmLineTickRecord = {
  readonly event_id: number;
  readonly ts_ms: number;
  readonly line_set: string;
  readonly flavor: "live" | "prematch";
  readonly sport_id: number;
  readonly league_id: number;
  readonly market_id: number;
  readonly market_kind: string;
  readonly period_kind: string;
  readonly line: number | null;
  readonly odds_a: number | null;
  readonly odds_b: number | null;
  readonly is_closing: number;
  readonly source_topic: string;
  readonly raw_sha256: string;
};

export interface PpmTicksTaxonomy {
  readonly office: "buckeye";
  readonly supplier: "ganchrow";
  readonly partnerId: number;
  readonly endpoint: "ppm-live-ticks";
  readonly provenance: "live_api";
}

export interface PpmTicksManifest {
  readonly schema_version: 1;
  readonly sink_id: "ppm-live-ticks";
  readonly generation_u32: number;
  readonly taxonomy: PpmTicksTaxonomy;
  readonly latest_chunk_key: string;
  readonly latest_chunk_sha256: string;
  readonly latest_chunk_rows: number;
  readonly total_flushed_rows: number;
  readonly data_window_min_epoch_ms: number;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly recent_chunks: readonly {
    readonly key: string;
    readonly sha256: string;
    readonly rows: number;
    readonly min_ts_ms: number;
    readonly max_ts_ms: number;
  }[];
}

export interface R2ObjectHeadLike {
  readonly etag: string;
  readonly httpEtag?: string;
}

export interface R2ObjectBodyLike extends R2ObjectHeadLike {
  text(): Promise<string>;
}

export interface R2PutOptionsLike {
  readonly onlyIf?: {
    readonly etagMatches?: string;
    readonly etagDoesNotMatch?: string;
  };
  readonly httpMetadata?: {
    readonly contentType?: string;
    readonly cacheControl?: string;
  };
  readonly customMetadata?: Record<string, string>;
}

/** Structural subset of Cloudflare `R2Bucket` for zero-friction unit testing and runtime parity. */
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value:
      string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectHeadLike | null>;
}

/** Strip weak `W/` prefix and surrounding double quotes before passing an ETag to `If-Match`. */
export function normalizeStrongEtag(
  rawEtag: string | null | undefined,
): string | null {
  if (!rawEtag) return null;
  const trimmed = rawEtag
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"+|"+$/g, "");
  return trimmed === "" ? null : trimmed;
}

export interface FlushTicksResult {
  readonly flushedRows: number;
  readonly chunkKey: string | null;
  readonly chunkSha256: string | null;
  readonly chunkAlreadyExisted: boolean;
  readonly manifestKey: string;
  readonly generationU32: number;
  readonly prevEtag: string | null;
  readonly newEtag: string | null;
  readonly dataWindowMaxEpochMs: number | null;
  readonly r2PublishedAtEpochMs: number;
}

const MAX_CAS_RETRIES = 4;
const MAX_RECENT_CHUNKS = 32;

export interface FlushTicksOptions {
  readonly manifestKey?: string;
  readonly chunkPrefix?: string;
  readonly sinkId?: "ppm-live-ticks" | "ppm-prematch-ticks";
}

/**
 * Flush a batch of ticks to an immutable content-addressed R2 NDJSON chunk (`If-None-Match: *`)
 * and advance the pointer manifest using strong-ETag CAS.
 */
export async function flushTicksBatchToR2(
  bucket: R2BucketLike,
  ticks: readonly PpmTickRecord[],
  taxonomy: PpmTicksTaxonomy,
  wallClock: WallClock = defaultWallClock,
  options: FlushTicksOptions = {},
): Promise<FlushTicksResult> {
  const manifestKey = options.manifestKey ?? PPM_TICKS_MANIFEST_KEY;
  const chunkPrefix = options.chunkPrefix ?? "ppm-live-ticks/chunks";
  const sinkId = options.sinkId ?? "ppm-live-ticks";
  const publishedAtMs = wallClock.nowMs();
  if (ticks.length === 0) {
    return {
      flushedRows: 0,
      chunkKey: null,
      chunkSha256: null,
      chunkAlreadyExisted: false,
      manifestKey,
      generationU32: 0,
      prevEtag: null,
      newEtag: null,
      dataWindowMaxEpochMs: null,
      r2PublishedAtEpochMs: publishedAtMs,
    };
  }

  let minTsMs = Number.POSITIVE_INFINITY;
  let maxTsMs = Number.NEGATIVE_INFINITY;
  const lines = Array.from<string>({ length: ticks.length });
  for (let i = 0; i < ticks.length; i += 1) {
    const t = ticks[i]!;
    if (t.ts_ms < minTsMs) minTsMs = t.ts_ms;
    if (t.ts_ms > maxTsMs) maxTsMs = t.ts_ms;
    lines[i] = JSON.stringify({
      office: taxonomy.office,
      supplier: taxonomy.supplier,
      partnerId: taxonomy.partnerId,
      endpoint: taxonomy.endpoint,
      provenance: taxonomy.provenance,
      event_id: t.event_id,
      ts_ms: t.ts_ms,
      sport_id: t.sport_id,
      league_id: t.league_id,
      home_score: t.home_score,
      away_score: t.away_score,
      period: t.period,
      clock_sec: t.clock_sec,
      is_blocked: t.is_blocked,
      score_changed: t.score_changed,
      source_topic: t.source_topic,
      raw_sha256: t.raw_sha256,
    });
  }

  const ndjsonBody = `${lines.join("\n")}\n`;
  const chunkSha256 = await sha256Hex(ndjsonBody);
  const deskDate = deskDateUtc(maxTsMs);
  const chunkKey = `${chunkPrefix}/${deskDate}/${chunkSha256}.ndjson`;

  // 1. Write content-addressed chunk with If-None-Match: * (idempotent create-if-absent)
  const chunkPut = await bucket.put(chunkKey, ndjsonBody, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/x-ndjson; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      "sink-id": sinkId,
      office: taxonomy.office,
      supplier: taxonomy.supplier,
      "partner-id": String(taxonomy.partnerId),
      "data-window-min-epoch-ms": String(minTsMs),
      "data-window-max-epoch-ms": String(maxTsMs),
      "r2-published-at-epoch-ms": String(publishedAtMs),
      sha256: chunkSha256,
      rows: String(ticks.length),
      pii: "none",
    },
  });
  const chunkAlreadyExisted = chunkPut === null;

  // 2. Advance pointer manifest using strong-ETag CAS (`If-Match` / `If-None-Match: *`)
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existingObj = await bucket.get(manifestKey);
    let prevManifest: PpmTicksManifest | null = null;
    let prevEtag: string | null = null;

    if (existingObj !== null) {
      prevEtag = normalizeStrongEtag(existingObj.httpEtag ?? existingObj.etag);
      try {
        prevManifest = JSON.parse(await existingObj.text()) as PpmTicksManifest;
      } catch {
        prevManifest = null;
      }
    }

    const nextGen = (prevManifest?.generation_u32 ?? 0) + 1;
    const prevChunks = Array.isArray(prevManifest?.recent_chunks)
      ? prevManifest.recent_chunks
      : [];
    const dedupedChunks = [
      {
        key: chunkKey,
        sha256: chunkSha256,
        rows: ticks.length,
        min_ts_ms: minTsMs,
        max_ts_ms: maxTsMs,
      },
      ...prevChunks.filter((c) => c.key !== chunkKey),
    ].slice(0, MAX_RECENT_CHUNKS);

    const nextManifest: PpmTicksManifest = {
      schema_version: 1,
      sink_id: "ppm-live-ticks",
      generation_u32: nextGen,
      taxonomy,
      latest_chunk_key: chunkKey,
      latest_chunk_sha256: chunkSha256,
      latest_chunk_rows: ticks.length,
      total_flushed_rows:
        (prevManifest?.total_flushed_rows ?? 0) +
        (chunkAlreadyExisted ? 0 : ticks.length),
      data_window_min_epoch_ms: Math.min(
        prevManifest?.data_window_min_epoch_ms ?? minTsMs,
        minTsMs,
      ),
      data_window_max_epoch_ms: Math.max(
        prevManifest?.data_window_max_epoch_ms ?? maxTsMs,
        maxTsMs,
      ),
      r2_published_at_epoch_ms: wallClock.nowMs(),
      recent_chunks: dedupedChunks,
    };

    const manifestPut = await bucket.put(
      manifestKey,
      `${JSON.stringify(nextManifest, null, 2)}\n`,
      {
        onlyIf: prevEtag
          ? { etagMatches: prevEtag }
          : { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType: "application/json; charset=utf-8",
          cacheControl: "no-store",
        },
        customMetadata: {
          "sink-id": sinkId,
          "generation-u32": String(nextGen),
          "data-window-max-epoch-ms": String(
            nextManifest.data_window_max_epoch_ms,
          ),
          "r2-published-at-epoch-ms": String(
            nextManifest.r2_published_at_epoch_ms,
          ),
          "latest-chunk-sha256": chunkSha256,
          pii: "none",
        },
      },
    );

    if (manifestPut !== null) {
      return {
        flushedRows: ticks.length,
        chunkKey,
        chunkSha256,
        chunkAlreadyExisted,
        manifestKey,
        generationU32: nextGen,
        prevEtag,
        newEtag: normalizeStrongEtag(manifestPut.httpEtag ?? manifestPut.etag),
        dataWindowMaxEpochMs: nextManifest.data_window_max_epoch_ms,
        r2PublishedAtEpochMs: nextManifest.r2_published_at_epoch_ms,
      };
    }
  }

  throw new Error(
    `R2 CAS conflict updating ${manifestKey} after ${MAX_CAS_RETRIES} attempts`,
  );
}

export const PPM_LINE_TICKS_MANIFEST_KEY = "manifests/ppm-live-lines/latest";

export interface PpmLineTicksManifest {
  readonly schema_version: 1;
  readonly sink_id: "ppm-live-lines" | "ppm-prematch-lines";
  readonly generation_u32: number;
  readonly taxonomy: PpmTicksTaxonomy;
  readonly latest_chunk_key: string;
  readonly latest_chunk_sha256: string;
  readonly latest_chunk_rows: number;
  readonly total_flushed_rows: number;
  readonly data_window_min_epoch_ms: number;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly recent_chunks: readonly {
    readonly key: string;
    readonly sha256: string;
    readonly rows: number;
    readonly min_ts_ms: number;
    readonly max_ts_ms: number;
  }[];
}

export interface FlushLineTicksOptions {
  readonly manifestKey?: string;
  readonly chunkPrefix?: string;
  readonly sinkId?: "ppm-live-lines" | "ppm-prematch-lines";
}

/**
 * Flush a batch of PPM coefficient/line ticks (including prematch closing snapshots) to an
 * immutable content-addressed R2 NDJSON chunk (`If-None-Match: *`) + strong-ETag CAS manifest.
 */
export async function flushLineTicksBatchToR2(
  bucket: R2BucketLike,
  ticks: readonly PpmLineTickRecord[],
  taxonomy: PpmTicksTaxonomy,
  wallClock: WallClock = defaultWallClock,
  options: FlushLineTicksOptions = {},
): Promise<FlushTicksResult> {
  const manifestKey = options.manifestKey ?? PPM_LINE_TICKS_MANIFEST_KEY;
  const chunkPrefix = options.chunkPrefix ?? "ppm-live-lines/chunks";
  const sinkId = options.sinkId ?? "ppm-live-lines";
  const publishedAtMs = wallClock.nowMs();
  if (ticks.length === 0) {
    return {
      flushedRows: 0,
      chunkKey: null,
      chunkSha256: null,
      chunkAlreadyExisted: false,
      manifestKey,
      generationU32: 0,
      prevEtag: null,
      newEtag: null,
      dataWindowMaxEpochMs: null,
      r2PublishedAtEpochMs: publishedAtMs,
    };
  }

  let minTsMs = Number.POSITIVE_INFINITY;
  let maxTsMs = Number.NEGATIVE_INFINITY;
  const lines = Array.from<string>({ length: ticks.length });
  for (let i = 0; i < ticks.length; i += 1) {
    const t = ticks[i]!;
    if (t.ts_ms < minTsMs) minTsMs = t.ts_ms;
    if (t.ts_ms > maxTsMs) maxTsMs = t.ts_ms;
    lines[i] = JSON.stringify({
      office: taxonomy.office,
      supplier: taxonomy.supplier,
      partnerId: taxonomy.partnerId,
      endpoint: taxonomy.endpoint,
      provenance: taxonomy.provenance,
      event_id: t.event_id,
      ts_ms: t.ts_ms,
      line_set: t.line_set,
      flavor: t.flavor,
      sport_id: t.sport_id,
      league_id: t.league_id,
      market_id: t.market_id,
      market_kind: t.market_kind,
      period_kind: t.period_kind,
      line: t.line,
      odds_a: t.odds_a,
      odds_b: t.odds_b,
      is_closing: t.is_closing,
      source_topic: t.source_topic,
      raw_sha256: t.raw_sha256,
    });
  }

  const ndjsonBody = `${lines.join("\n")}\n`;
  const chunkSha256 = await sha256Hex(ndjsonBody);
  const deskDate = deskDateUtc(maxTsMs);
  const chunkKey = `${chunkPrefix}/${deskDate}/${chunkSha256}.ndjson`;

  const chunkPut = await bucket.put(chunkKey, ndjsonBody, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/x-ndjson; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      "sink-id": sinkId,
      office: taxonomy.office,
      supplier: taxonomy.supplier,
      "partner-id": String(taxonomy.partnerId),
      "data-window-min-epoch-ms": String(minTsMs),
      "data-window-max-epoch-ms": String(maxTsMs),
      "r2-published-at-epoch-ms": String(publishedAtMs),
      sha256: chunkSha256,
      rows: String(ticks.length),
      pii: "none",
    },
  });
  const chunkAlreadyExisted = chunkPut === null;

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const existingObj = await bucket.get(manifestKey);
    let prevManifest: PpmLineTicksManifest | null = null;
    let prevEtag: string | null = null;

    if (existingObj !== null) {
      prevEtag = normalizeStrongEtag(existingObj.httpEtag ?? existingObj.etag);
      try {
        prevManifest = JSON.parse(
          await existingObj.text(),
        ) as PpmLineTicksManifest;
      } catch {
        prevManifest = null;
      }
    }

    const nextGen = (prevManifest?.generation_u32 ?? 0) + 1;
    const prevChunks = Array.isArray(prevManifest?.recent_chunks)
      ? prevManifest.recent_chunks
      : [];
    const dedupedChunks = [
      {
        key: chunkKey,
        sha256: chunkSha256,
        rows: ticks.length,
        min_ts_ms: minTsMs,
        max_ts_ms: maxTsMs,
      },
      ...prevChunks.filter((c) => c.key !== chunkKey),
    ].slice(0, MAX_RECENT_CHUNKS);

    const nextManifest: PpmLineTicksManifest = {
      schema_version: 1 as const,
      sink_id: sinkId,
      generation_u32: nextGen,
      taxonomy,
      latest_chunk_key: chunkKey,
      latest_chunk_sha256: chunkSha256,
      latest_chunk_rows: ticks.length,
      total_flushed_rows:
        (prevManifest?.total_flushed_rows ?? 0) +
        (chunkAlreadyExisted ? 0 : ticks.length),
      data_window_min_epoch_ms: Math.min(
        prevManifest?.data_window_min_epoch_ms ?? minTsMs,
        minTsMs,
      ),
      data_window_max_epoch_ms: Math.max(
        prevManifest?.data_window_max_epoch_ms ?? maxTsMs,
        maxTsMs,
      ),
      r2_published_at_epoch_ms: wallClock.nowMs(),
      recent_chunks: dedupedChunks,
    };

    const manifestPut = await bucket.put(
      manifestKey,
      `${JSON.stringify(nextManifest, null, 2)}\n`,
      {
        onlyIf: prevEtag
          ? { etagMatches: prevEtag }
          : { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType: "application/json; charset=utf-8",
          cacheControl: "no-store",
        },
        customMetadata: {
          "sink-id": sinkId,
          "generation-u32": String(nextGen),
          "data-window-max-epoch-ms": String(
            nextManifest.data_window_max_epoch_ms,
          ),
          "r2-published-at-epoch-ms": String(
            nextManifest.r2_published_at_epoch_ms,
          ),
          "latest-chunk-sha256": chunkSha256,
          pii: "none",
        },
      },
    );

    if (manifestPut !== null) {
      return {
        flushedRows: ticks.length,
        chunkKey,
        chunkSha256,
        chunkAlreadyExisted,
        manifestKey,
        generationU32: nextGen,
        prevEtag,
        newEtag: normalizeStrongEtag(manifestPut.httpEtag ?? manifestPut.etag),
        dataWindowMaxEpochMs: nextManifest.data_window_max_epoch_ms,
        r2PublishedAtEpochMs: nextManifest.r2_published_at_epoch_ms,
      };
    }
  }

  throw new Error(
    `R2 CAS conflict updating ${manifestKey} after ${MAX_CAS_RETRIES} attempts`,
  );
}
