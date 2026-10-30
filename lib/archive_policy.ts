/**
 * Compression policy — two Bun APIs, two level scales (do not merge constants).
 *
 * - Bun.Archive gzip: level 1–12 (12 = max gzip for archives)
 * - CompressionStream brotli/gzip: level 0–9 (different scale, different codec)
 */

/** EOD tar.gz archives (Bun.Archive). */
export const ARCHIVE_COMPRESS = { compress: "gzip" as const, level: 4 };

/** Streaming HTTP / pipe compression (CompressionStream). */
export const STREAM_COMPRESS_BROTLI = { level: 4 as const };
