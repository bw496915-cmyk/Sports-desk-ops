/**
 * File-backed artifacts, read once per version instead of once per request.
 *
 * `/api/agent-tree` re-read and re-parsed a 94 KB JSON file on every request (measured 0.85 ms,
 * versus 0.10 ms for a route that returns a constant), `/api/contests` a 110 KB one, and the graph
 * feed a 217 KB one. The files change only when a capture rewrites them, so the version key is the
 * file's mtime and size: a rewrite invalidates the cache immediately, with no TTL to guess and no
 * window where a stale artifact is served.
 *
 * Every read is gated by `lstat(path)` + `Bun.file(path).stat()` so symlinks, directories, sockets,
 * device nodes, and FIFOs (where `Bun.file(fifo).exists()` returns `true` and blocks on read) fail
 * closed as `null`. A missing file is not cached — creating the file is visible on the next request.
 */

import type { BunFile } from "bun";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";

export interface ArtifactVersion<T> {
  /** `mtimeMs:size`, the cache key; also the body-cache version for lib/http_compression. */
  readonly version: string;
  readonly value: T;
}

export interface RegularFileEntry {
  readonly file: BunFile;
  readonly stat: Stats;
  readonly version: string;
}

const parsed = new Map<string, ArtifactVersion<unknown>>();
const bytes = new Map<string, ArtifactVersion<Uint8Array<ArrayBuffer>>>();
/** Must exceed the daemon's artifact count, or every full-cache insert clears the rest. */
const MAX_CACHED_FILES = 16;

/**
 * Verifies `path` is a non-symlink regular file (`!linkStat.isSymbolicLink() && fileStat.isFile()`)
 * with matching `(dev, ino)` across `lstat` and `BunFile.stat()`.
 */
export async function statRegularFile(
  path: string,
): Promise<RegularFileEntry | null> {
  const file = Bun.file(path);
  const [linkStat, fileStat] = await Promise.all([
    lstat(path).catch(() => null),
    file.stat().catch(() => null),
  ]);
  if (
    linkStat === null ||
    fileStat === null ||
    linkStat.isSymbolicLink() ||
    !linkStat.isFile() ||
    !fileStat.isFile() ||
    linkStat.ino !== fileStat.ino ||
    linkStat.dev !== fileStat.dev
  ) {
    return null;
  }
  return {
    file,
    stat: fileStat,
    version: `${fileStat.mtimeMs}:${fileStat.size}`,
  };
}

function remember<T>(
  cache: Map<string, ArtifactVersion<unknown>>,
  path: string,
  version: string,
  value: T,
): ArtifactVersion<T> {
  if (cache.size >= MAX_CACHED_FILES) cache.clear();
  const entry: ArtifactVersion<T> = { version, value };
  cache.set(path, entry as ArtifactVersion<unknown>);
  return entry;
}

/**
 * A JSON file whose parsed contents are reused until its mtime or size changes.
 *
 * `parse` runs inside the cache miss, so a shape error surfaces on the request that notices the
 * new file rather than at startup — the same behaviour as reading the file directly.
 */
export function cachedJsonFile<T>(
  path: string,
  parse: (raw: unknown) => T,
): { read(): Promise<ArtifactVersion<T> | null> } {
  return {
    async read(): Promise<ArtifactVersion<T> | null> {
      const entry = await statRegularFile(path);
      if (entry === null) {
        parsed.delete(path);
        return null;
      }
      const hit = parsed.get(path);
      if (hit !== undefined && hit.version === entry.version) {
        return hit as ArtifactVersion<T>;
      }
      const value = parse(await entry.file.json());
      return remember(parsed, path, entry.version, value);
    },
  };
}

/** Raw bytes of a regular non-symlink file plus their version, or `null` when absent/irregular. */
export async function readFileBytes(
  path: string,
): Promise<ArtifactVersion<Uint8Array<ArrayBuffer>> | null> {
  const entry = await statRegularFile(path);
  if (entry === null) {
    bytes.delete(path);
    return null;
  }
  const hit = bytes.get(path);
  if (hit !== undefined && hit.version === entry.version) return hit;
  const buf = await entry.file.arrayBuffer();
  if (buf.byteLength !== entry.stat.size) {
    bytes.delete(path);
    return null;
  }
  const value = new Uint8Array<ArrayBuffer>(buf);
  return remember(bytes, path, entry.version, value);
}

/** Drop every cached artifact; tests use it to prove invalidation is real. */
export function resetArtifactCache(): void {
  parsed.clear();
  bytes.clear();
}
