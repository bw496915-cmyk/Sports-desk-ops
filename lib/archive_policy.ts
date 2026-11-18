/**
 * Compression policy — two Bun APIs, two level scales (do not merge constants).
 *
 * The scales differ because the encoders differ (measured 2026-11-17 on Bun 1.4.4):
 *
 * - `Bun.Archive` gzip → vendored libdeflate, levels 1–12 (12 = best). `level: 0`
 *   or `13` throws `TypeError: Archive: level must be between 1 and 12`.
 * - `Bun.gzipSync` / `node:zlib` / `CompressionStream` → vendored zlib-ng, levels
 *   0–9. `level: 10` throws `Zlib error: Invalid argument`.
 *
 * At the same nominal level the two produce different bytes, so a level tuned for
 * one is not a level tuned for the other.
 */

/** EOD tar.gz archives (Bun.Archive). */
export const ARCHIVE_COMPRESS = { compress: "gzip" as const, level: 4 };

/** Streaming HTTP / pipe compression (CompressionStream). */
export const STREAM_COMPRESS_BROTLI = { level: 4 as const };
