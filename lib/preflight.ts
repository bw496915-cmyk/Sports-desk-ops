/**
 * @file lib/preflight.ts
 * @description Name resolution and TLS reachability check before a capture run.
 *
 * Without it, a DNS failure surfaces as a WebView `navigate` error or a `fetch` rejection, which
 * reads like a portal problem. This distinguishes "the name does not resolve" from "the handshake
 * failed" from "the page did not load".
 */

import type { DnsResolverBackend } from "./bun_dns.ts";
import { type TlsProvenance, probeTls } from "./tls_provenance.ts";

export interface DnsAnswer {
  readonly address: string;
  readonly family: 4 | 6;
  readonly ttl: number;
}

export interface PreflightResult {
  readonly host: string;
  readonly port: number;
  readonly dns: readonly DnsAnswer[];
  readonly tls: TlsProvenance | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly dnsPrefetched?: boolean;
  readonly dnsCacheStats?: Record<string, number>;
}

const DEFAULT_URL_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
  "ws:": 80,
  "wss:": 443,
};

function assertDnsPort(port: number, context: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`ERR_DNS_INVALID_PREFETCH_PORT: ${context}`);
  }
}

/** Port precedence: explicit URL port, then scheme default; validated for prefetch. */
export function resolveUrlPort(url: URL): number {
  const port =
    url.port.length > 0 ? Number(url.port) : DEFAULT_URL_PORTS[url.protocol];
  if (port === undefined) {
    throw new RangeError(`ERR_DNS_INVALID_PREFETCH_PORT: ${url.href}`);
  }
  assertDnsPort(port, url.href);
  return port;
}

/** Pre-warm Bun's DNS cache before WebView navigate / fetch (see bun.com/docs/runtime/networking/dns). */
export function prefetchDns(host: string, port = 443): void {
  const trimmed = host.trim();
  if (trimmed === "") return;
  assertDnsPort(port, `${trimmed}:${String(port)}`);
  const target =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  Bun.dns.prefetch(target, port);
}

/** Warm the DNS cache for a URL before its HTTP/WebSocket connection is opened. */
export function prefetchUrl(url: URL): void {
  prefetchDns(url.hostname, resolveUrlPort(url));
}

export function readDnsCacheStats(): Record<string, number> | undefined {
  try {
    const stats = Bun.dns.getCacheStats?.();
    if (typeof stats !== "object" || stats === null) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(stats as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * DNS prefetch + optional fetch.preconnect for HTTPS capture bases.
 */
export function warmCaptureNetwork(baseUrl: string): {
  host: string;
  port: number;
} {
  const parsed = new URL(baseUrl);
  const port = resolveUrlPort(parsed);
  prefetchDns(parsed.hostname, port);
  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    try {
      fetch.preconnect(parsed.origin);
    } catch {
      // preconnect is best-effort
    }
  }
  return { host: parsed.hostname, port };
}

export type DnsLookupFamily = 0 | 4 | 6 | "IPv4" | "IPv6" | "any";
export type DnsLookupSocketType = "udp" | "tcp";

export interface DnsLookupOptions {
  /** Restrict to IPv4 (4), IPv6 (6), any family (0), or the documented string aliases. */
  readonly family?: DnsLookupFamily;
  /** Resolver flags such as `ADDRCONFIG`, `V4MAPPED` or `ALL`; omit for the default. */
  readonly flags?: number;
  /** Resolver backend; see https://bun.sh/reference/bun/dns#dns-resolver-client. */
  readonly backend?: DnsResolverBackend;
  /** Port keying the resolver entry; the docs note it distinguishes IPv6 vs IPv4-only connections. */
  readonly port?: number;
  /** Resolver socket type; `udp` is the default. */
  readonly socketType?: DnsLookupSocketType;
}

/**
 * Resolve a host through Bun's DNS cache. The option contract is documented at
 * https://bun.sh/reference/bun/dns#basic-usage; the resolver note is at
 * https://bun.sh/reference/bun/dns#dns-resolver-client.
 */
export async function resolveHost(
  host: string,
  options?: DnsLookupOptions,
): Promise<DnsAnswer[]> {
  const answers = await Bun.dns.lookup(host, {
    ...options,
    // HTTPS callers need the TCP resolver path; backend/family stay at Bun's defaults.
    socketType: options?.socketType ?? "tcp",
  });
  return answers.map((answer) => ({
    address: String(answer.address),
    family: answer.family,
    ttl: Number(answer.ttl),
  }));
}

export async function preflight(
  host: string,
  options: {
    port?: number;
    timeoutMs?: number;
    skipDnsPrefetch?: boolean;
  } = {},
): Promise<PreflightResult> {
  const port = options.port ?? 443;
  if (!options.skipDnsPrefetch) prefetchDns(host, port);
  const dnsCacheStats = readDnsCacheStats();
  let dns: DnsAnswer[] = [];
  try {
    dns = await resolveHost(host);
  } catch (error) {
    return {
      host,
      port,
      dns: [],
      tls: null,
      ok: false,
      error: `DNS lookup failed for ${host}: ${(error as Error).message}`,
      dnsPrefetched: !options.skipDnsPrefetch,
      ...(dnsCacheStats ? { dnsCacheStats } : {}),
    };
  }

  try {
    const tls = await probeTls({
      host,
      port,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    return {
      host,
      port,
      dns,
      tls,
      ok: true,
      error: null,
      dnsPrefetched: !options.skipDnsPrefetch,
      ...(dnsCacheStats ? { dnsCacheStats } : {}),
    };
  } catch (error) {
    return {
      host,
      port,
      dns,
      tls: null,
      ok: false,
      error: `TLS handshake failed for ${host}:${port}: ${(error as Error).message}`,
      dnsPrefetched: !options.skipDnsPrefetch,
      ...(dnsCacheStats ? { dnsCacheStats } : {}),
    };
  }
}

export function formatPreflight(result: PreflightResult): string {
  if (!result.ok) return `preflight: ${result.error ?? "failed"}`;
  const tls = result.tls;
  const addresses = result.dns.map((answer) => answer.address).join(", ");
  return [
    `preflight: ${result.host}:${result.port} resolves (${result.dns.length} address(es): ${addresses})`,
    tls === null
      ? "  tls: not probed"
      : `  tls: ${tls.tlsVersion} ${tls.cipher.name} · authorized=${tls.authorized} · ${tls.connectMs} ms`,
  ].join("\n");
}
