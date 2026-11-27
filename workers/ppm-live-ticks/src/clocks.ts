/**
 * Strict separation between monotonic elapsed clocks (`MonotonicClock.nowNs()`) and wall-clock
 * event timestamps (`WallClock.nowMs()`), plus lazy Web Crypto entropy (NEVER invoked at module
 * evaluation time — Cloudflare Workers forbid `crypto.getRandomValues` in global scope).
 *
 * @file workers/ppm-live-ticks/src/clocks.ts
 */

export interface MonotonicClock {
  /** Monotonic nanoseconds for durations, heartbeat deadlines, and backoff intervals only. */
  nowNs(): bigint;
}

export interface WallClock {
  /** Wall-clock Unix epoch milliseconds for event `ts_ms`, data windows, and publish timestamps. */
  nowMs(): number;
}

export const defaultMonotonicClock: MonotonicClock = {
  nowNs(): bigint {
    // `performance.now()` is monotonic in both Cloudflare Workers and Bun, and never touches I/O.
    return BigInt(Math.round(performance.now() * 1_000_000));
  },
};

export const defaultWallClock: WallClock = {
  nowMs(): number {
    return Date.now();
  },
};

export function elapsedMsFromNs(startNs: bigint, endNs: bigint): number {
  const diff = endNs - startNs;
  return diff <= 0n ? 0 : Number(diff) / 1_000_000;
}

export function deskDateUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Lazy runtime entropy helper — ONLY call inside request/DO/alarm handlers, never at module load.
 */
export function lazyRandomHex(byteLength = 8): string {
  const len = Math.max(1, Math.min(64, Math.trunc(byteLength)));
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i += 1) {
    out += buf[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Lazy cryptographic unit uniform in `[0, 1)` using `crypto.getRandomValues`.
 */
export function lazyRandomUnit(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 0x1_0000_0000;
}

/**
 * Bounded exponential backoff with full jitter using lazy Web Crypto randomness.
 */
export function computeReconnectBackoffMs(
  attempt: number,
  baseMs = 1_000,
  maxMs = 30_000,
  unitRng: () => number = lazyRandomUnit,
): number {
  const safeAttempt = Math.max(0, Math.min(16, Math.trunc(attempt)));
  const ceiling = Math.min(maxMs, baseMs * 2 ** safeAttempt);
  const jitter = Math.floor(
    Math.max(0, Math.min(0.999999, unitRng())) * (ceiling * 0.25),
  );
  return Math.min(maxMs, ceiling + jitter);
}

const UTF8_ENCODER = new TextEncoder();

/**
 * Constant-time bearer token check using SHA-256 digests so token length differences never leak.
 * Uses `crypto.subtle.timingSafeEqual` when available (Cloudflare Workers) with XOR fallback.
 */
export async function timingSafeBearerMatch(
  authorizationHeader: string | null,
  expectedSecret: string | undefined,
): Promise<boolean> {
  if (!expectedSecret || expectedSecret.trim() === "") return false;
  if (!authorizationHeader) return false;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return false;
  const presented = trimmed.slice(7).trim();
  if (presented === "") return false;

  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", UTF8_ENCODER.encode(presented)),
    crypto.subtle.digest("SHA-256", UTF8_ENCODER.encode(expectedSecret.trim())),
  ]);
  const a = new Uint8Array(aHash);
  const b = new Uint8Array(bHash);

  const subtleWithTiming = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (
      left: ArrayBufferView | ArrayBuffer,
      right: ArrayBufferView | ArrayBuffer,
    ) => boolean;
  };
  if (typeof subtleWithTiming.timingSafeEqual === "function") {
    return subtleWithTiming.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
