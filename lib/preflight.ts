/**
 * @file lib/preflight.ts
 * @description Name resolution and TLS reachability check before a capture run.
 *
 * Without it, a DNS failure surfaces as a WebView `navigate` error or a `fetch` rejection, which
 * reads like a portal problem. This distinguishes "the name does not resolve" from "the handshake
 * failed" from "the page did not load".
 */

import { type TlsProvenance, probeTls } from "./tls_provenance.ts";

export interface DnsAnswer {
  readonly address: string;
  readonly family: number;
  readonly ttl: number;
}

export interface PreflightResult {
  readonly host: string;
  readonly port: number;
  readonly dns: readonly DnsAnswer[];
  readonly tls: TlsProvenance | null;
  readonly ok: boolean;
  readonly error: string | null;
}

export async function resolveHost(host: string): Promise<DnsAnswer[]> {
  const answers = await Bun.dns.lookup(host);
  return answers.map((answer) => ({
    address: String(answer.address),
    family: Number(answer.family),
    ttl: Number(answer.ttl),
  }));
}

export async function preflight(
  host: string,
  options: { port?: number; timeoutMs?: number } = {},
): Promise<PreflightResult> {
  const port = options.port ?? 443;
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
    };
  }

  try {
    const tls = await probeTls({
      host,
      port,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    return { host, port, dns, tls, ok: true, error: null };
  } catch (error) {
    return {
      host,
      port,
      dns,
      tls: null,
      ok: false,
      error: `TLS handshake failed for ${host}:${port}: ${(error as Error).message}`,
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
