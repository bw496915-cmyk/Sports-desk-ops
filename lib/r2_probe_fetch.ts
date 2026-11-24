/**
 * @file r2_probe_fetch.ts
 * @description One fetch transport for reads against the public R2 keys this repo publishes.
 *
 * The desk (`/api/kpis`, `/api/status`) and the GitHub Actions staleness alerter used to read the
 * same bucket through separate transports. When `*.r2.dev` public hosting was turned off
 * (measured 2026-11-24: the bucket root, an existing key and a nonexistent key all answered
 * `401`), the desk was fixed and the alerter kept probing anonymously — 250 consecutive failed
 * runs over 15 days. This module is the single place that decides how a key is read, so the next
 * transport change lands once.
 *
 * Routing: a URL under `R2_PUBLIC_BASE` is presigned when credentials resolve (env first, then
 * keychain) and fetched anonymously when they do not; any other URL passes through untouched. The
 * public URL stays the caller's identity for a key — presigning only changes the hop.
 */

import { R2S3Client } from "./r2_s3_client.ts";
import { R2_PUBLIC_BASE } from "./r2_staleness.ts";

/** Per-request ceiling shared by the desk probe and the alerter. */
export const DEFAULT_R2_PROBE_TIMEOUT_MS = 5_000;

const PUBLIC_R2_PREFIX = `${R2_PUBLIC_BASE.replace(/\/+$/, "")}/`;

/** The methods a freshness probe needs: HEAD for `Last-Modified`, GET for the pointer body. */
export interface R2ProbeInit {
  readonly method?: "GET" | "HEAD";
  readonly headers?: RequestInit["headers"];
  readonly signal?: AbortSignal;
}

export type R2ProbeFetcher = (
  url: string,
  init?: R2ProbeInit,
) => Promise<Response>;

/** Anonymous transport: the original behaviour, kept for credential-free callers. */
export const plainR2ProbeFetch: R2ProbeFetcher = (url, init) =>
  fetch(url, {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    // A caller-managed signal (an injected fetcher's timeout) wins over the default ceiling.
    signal: init?.signal ?? AbortSignal.timeout(DEFAULT_R2_PROBE_TIMEOUT_MS),
  });

/** What a probe needs from the client: presigning, nothing that writes. */
export type R2ProbePresigner = Pick<R2S3Client, "presign">;

export type R2ProbeClientFactory = () => Promise<R2ProbePresigner | null>;

/**
 * Route `R2_PUBLIC_BASE` requests through `R2S3Client.presign` (HEAD/GET) so probes keep working
 * when public `*.r2.dev` hosting is off, while unrelated URLs pass through unchanged.
 *
 * A presigned URL carries a short-lived signature in its query string, and a failed fetch can quote
 * the URL it could not reach. The wrapper replaces such an error with a message naming only the
 * key, so the signature cannot reach `/api/kpis`, a log line or a Telegram alert body.
 */
export function createR2S3ProbeFetcher(
  client: R2ProbePresigner,
  baseFetch: R2ProbeFetcher = plainR2ProbeFetch,
): R2ProbeFetcher {
  return async (url, init) => {
    if (!url.startsWith(PUBLIC_R2_PREFIX)) {
      return baseFetch(url, init);
    }
    const key = url.slice(PUBLIC_R2_PREFIX.length).replace(/^\/+/, "");
    const signedUrl = client.presign(key, {
      method: init?.method ?? "HEAD",
      expiresIn: 60,
    });
    try {
      return await baseFetch(signedUrl, init);
    } catch (err) {
      const name = err instanceof Error ? err.name : "unknown";
      // The caught error can quote the presigned URL, so only its sanitized
      // name is attached; leaking the signature is worse than a bare cause.
      // oxlint-disable-next-line preserve-caught-error -- see the note above.
      throw new Error(`R2 signed probe failed for ${key} (${name})`, {
        cause: name,
      });
    }
  };
}

/** How a run reached R2 — recorded so a silent anonymous fallback is visible in the log. */
export type R2ProbeTransportKind = "injected" | "signed" | "anonymous";

export interface R2ProbeTransport {
  readonly fetch: R2ProbeFetcher;
  readonly kind: R2ProbeTransportKind;
}

/**
 * Resolve the transport once per run. `clientFactory` is injectable because tests must never
 * reach the real keychain (AGENTS.md: "Tests never read the real keychain").
 */
export async function resolveR2ProbeTransport(
  fetchImpl?: R2ProbeFetcher,
  clientFactory: R2ProbeClientFactory = () => R2S3Client.fromEnvOrSecrets(),
): Promise<R2ProbeTransport> {
  if (fetchImpl !== undefined) return { fetch: fetchImpl, kind: "injected" };
  const client = await clientFactory().catch(() => null);
  return client === null
    ? { fetch: plainR2ProbeFetch, kind: "anonymous" }
    : { fetch: createR2S3ProbeFetcher(client), kind: "signed" };
}
