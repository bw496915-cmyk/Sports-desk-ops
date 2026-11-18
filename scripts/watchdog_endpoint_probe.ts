#!/usr/bin/env bun
/**
 * @file watchdog_endpoint_probe.ts
 * @description Independent endpoint watchdog for the desk's core hosts. Probes DNS resolution
 * (`Bun.dns.lookup`) and HTTPS reachability for `SPORTSDESK_CORE_HOSTS`, persists consecutive
 * failures, and pages Telegram only after two consecutive failures.
 *
 * Cadence: LaunchAgent `StartInterval 900` (15 minutes). DNS/TLS/endpoint health degrades slower
 * than a session heartbeat, and a single probe miss is noise; two in a row is a signal.
 *
 * Telemetry vs gating: `prefetch`/`getCacheStats` are reported (when `--json`) and never decide
 * the verdict. The verdict comes from the observable path: lookup + fetch. A 3xx/4xx counts as
 * reachable (Telegram's API root answers 404 by design); a 5xx or a missing response does not.
 *
 * Exit codes: 0 healthy (or --dry-run), 1 alert detected and sent, 2 could not evaluate or alert.
 *
 * Install: scripts/install_endpoint_watch_agent.sh install
 * Runbook: docs/runbooks/endpoint_watchdog.md
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  SPORTSDESK_CORE_HOSTS,
  type DnsResolverBackend,
  type HostTarget,
} from "../lib/bun_dns.ts";
import {
  readDnsCacheStats,
  resolveHost,
  type DnsAnswer,
  type DnsLookupOptions,
} from "../lib/preflight.ts";
import { probeTls, type TlsProvenance } from "../lib/tls_provenance.ts";
import { resolveTelegramCredentials } from "../lib/telegram_alert_sender.ts";
import {
  ENDPOINT_PROBE_DEFAULT_FAIL_THRESHOLD,
  ENDPOINT_PROBE_INTERVAL_SECONDS,
  ENDPOINT_PROBE_STATE_SCHEMA_VERSION,
  evaluateEndpointProbe,
  type EndpointProbeFetch,
  type EndpointProbeObservation,
  type EndpointProbeState,
  type EndpointProbeVerdict,
} from "../lib/watchdog/endpoint_probe.ts";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_STATE_PATH = resolve(
  ROOT,
  "scratch",
  "watchdog",
  "endpoint-probe-state.json",
);
const PROBE_TIMEOUT_MS = 5_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const EXIT = { ok: 0, alert: 1, error: 2 } as const;

/**
 * The runner leaves the resolver backend unset by default: the probe must measure the path the
 * app's fetch()/Bun.connect() takes, and Bun's default differs by OS (c-ares on Linux,
 * system/getaddrinfo on macOS). `default` is the sentinel meaning "do not pass backend".
 * https://bun.sh/reference/bun/dns#dns-resolver-client
 */
const DEFAULT_DNS_BACKEND = "default" as const;
type ProbeBackend = DnsResolverBackend | typeof DEFAULT_DNS_BACKEND;

export type HttpVersion = "auto" | "http1.1" | "http2" | "http3";
const HTTP_VERSIONS: readonly HttpVersion[] = [
  "auto",
  "http1.1",
  "http2",
  "http3",
];
const DNS_BACKENDS: readonly ProbeBackend[] = [
  DEFAULT_DNS_BACKEND,
  "c-ares",
  "system",
  "getaddrinfo",
  "libc",
];

interface Options {
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly hosts: readonly string[];
  readonly backend: ProbeBackend;
  readonly port?: number;
  readonly ip?: string;
  readonly allIps: boolean;
  readonly httpVersion: HttpVersion;
  readonly wsUrl?: string;
  readonly statePath: string;
  readonly help: boolean;
}

interface StateFile {
  readonly schemaVersion: typeof ENDPOINT_PROBE_STATE_SCHEMA_VERSION;
  readonly hosts: Readonly<Record<string, EndpointProbeState>>;
}

interface ProbeJson {
  readonly schemaVersion: 1;
  readonly checkedAt: string;
  readonly intervalSeconds: number;
  readonly dryRun: boolean;
  readonly resolver: ProbeBackend;
  readonly socketType: "tcp";
  readonly ip: string | null;
  readonly allIps: boolean;
  readonly httpVersion: HttpVersion;
  readonly mode: "http" | "websocket";
  readonly wsUrl: string | null;
  readonly alerts: number;
  readonly hosts: readonly {
    readonly host: string;
    readonly service: string;
    readonly port: number;
    readonly status: "ok" | "alert";
    readonly code: string | null;
    readonly consecutiveFailures: number;
    readonly message: string;
    readonly addresses: readonly string[];
    readonly ttlSeconds: readonly number[];
    readonly addressProbes: readonly AddressProbe[];
    readonly tls: TlsProvenance | null;
    readonly tlsError: string | null;
    readonly fetchStatus: number | null;
    readonly latencyMs: number | null;
    readonly cacheStats: Readonly<Record<string, number>> | null;
  }[];
}

export interface AddressProbe {
  readonly address: string;
  readonly family: 4 | 6;
  readonly status: number | null;
  readonly latencyMs: number | null;
  readonly error: string | null;
  readonly tls: TlsProvenance | null;
  readonly tlsError: string | null;
}

interface ProbeResult {
  readonly observation: EndpointProbeObservation;
  readonly addressProbes: readonly AddressProbe[];
  readonly tls: TlsProvenance | null;
  readonly tlsError: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseBackend(raw: string | undefined): ProbeBackend {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DNS_BACKEND;
  const backend = DNS_BACKENDS.find((candidate) => candidate === raw.trim());
  if (backend === undefined) {
    throw new Error(
      `invalid --backend "${raw}" (allowed: ${DNS_BACKENDS.join(", ")})`,
    );
  }
  return backend;
}

function parseHttpVersion(raw: string | undefined): HttpVersion {
  if (raw === undefined || raw.trim() === "") return "auto";
  const value = raw.trim().toLowerCase();
  const normalized =
    value === "h1"
      ? "http1.1"
      : value === "h2"
        ? "http2"
        : value === "h3"
          ? "http3"
          : value;
  const found = HTTP_VERSIONS.find((version) => version === normalized);
  if (found === undefined) {
    throw new Error(
      `invalid --http-version "${raw}" (allowed: auto, http1.1, http2, http3; aliases h1/h2/h3)`,
    );
  }
  return found;
}

function parseWsUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`invalid --ws-url "${raw}"`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`--ws-url must use ws:// or wss:// (got ${url.protocol})`);
  }
  if (url.hostname === "") throw new Error("--ws-url requires a hostname");
  return url.href;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port "${raw}" (expected 1-65535)`);
  }
  return port;
}

function parseIp(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const ip = raw.trim();
  if (isIP(ip) === 0) {
    throw new Error(`invalid --ip "${raw}" (expected IPv4 or IPv6)`);
  }
  return ip;
}

export function parseOptions(
  argv: readonly string[] = Bun.argv.slice(2),
): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      host: { type: "string", multiple: true },
      backend: { type: "string" },
      port: { type: "string" },
      ip: { type: "string" },
      "all-ips": { type: "boolean", default: false },
      "http-version": { type: "string" },
      "ws-url": { type: "string" },
      state: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const dryRun = values["dry-run"] ?? false;
  const hosts = values.host ?? [];
  const port = parsePort(values.port);
  const ip = parseIp(values.ip);
  const allIps = values["all-ips"] ?? false;
  const httpVersion = parseHttpVersion(values["http-version"]);
  const wsUrl = parseWsUrl(values["ws-url"]);
  if (wsUrl !== undefined) {
    if (!dryRun) {
      throw new Error("--ws-url is diagnostic and requires --dry-run");
    }
    if (
      hosts.length > 0 ||
      port !== undefined ||
      ip !== undefined ||
      allIps ||
      httpVersion !== "auto"
    ) {
      throw new Error(
        "--ws-url cannot be combined with --host/--port/--ip/--all-ips/--http-version",
      );
    }
  } else {
    const diagnostic =
      port !== undefined ||
      ip !== undefined ||
      allIps ||
      httpVersion !== "auto";
    if (diagnostic && !dryRun) {
      throw new Error(
        "--port/--ip/--all-ips/--http-version are diagnostic and require --dry-run",
      );
    }
    if (diagnostic && hosts.length !== 1) {
      throw new Error(
        "--port/--ip/--all-ips/--http-version require exactly one --host",
      );
    }
  }
  return {
    json: values.json ?? false,
    dryRun,
    hosts,
    backend: parseBackend(values.backend),
    ...(port === undefined ? {} : { port }),
    ...(ip === undefined ? {} : { ip }),
    allIps,
    httpVersion,
    ...(wsUrl === undefined ? {} : { wsUrl }),
    statePath:
      values.state === undefined || values.state.trim() === ""
        ? DEFAULT_STATE_PATH
        : resolve(values.state),
    help: values.help ?? false,
  };
}

function usage(): string {
  return `Endpoint watchdog — DNS + HTTPS reachability for the desk's core hosts.

Usage: bun run scripts/watchdog_endpoint_probe.ts [flags]

Flags:
  --host <hostname>   Probe only this core host (repeatable). Default: all core hosts.
  --port <n>          Target port override, 1-65535. Diagnostic: requires one --host and --dry-run.
  --ip <addr>         Dial this IPv4/IPv6 address for the fetch, keeping the hostname for TLS
                      SNI and Host. Diagnostic: requires one --host and --dry-run.
  --all-ips           Also probe every address returned by the DNS lookup, with per-address
                      results in --json. Diagnostic: requires one --host and --dry-run.
  --http-version <v>  Force HTTP: auto (default) | http1.1 | http2 | http3 (aliases h1/h2/h3).
                      Diagnostic: requires one --host and --dry-run. http2/http3 are experimental;
                      http3 is QUIC, so the TCP TLS provenance is skipped.
  --ws-url <url>      Probe a ws:// or wss:// WebSocket upgrade instead of an HTTP GET.
                      Diagnostic: requires --dry-run; cannot combine with the target flags.
  --backend <name>    DNS resolver: default (Bun platform default) | c-ares | system |
                      getaddrinfo | libc. The default leaves the choice to Bun so the probe
                      mirrors the app's fetch()/Bun.connect() path; override for diagnosis.
  --state <path>      State file (default: scratch/watchdog/endpoint-probe-state.json).
  --dry-run           Probe and print, but do not write state or page Telegram.
  --json              Print one JSON object on stdout.
  -h, --help          Show this help.

Cadence: LaunchAgent StartInterval 900 (15 min); pages after ${ENDPOINT_PROBE_DEFAULT_FAIL_THRESHOLD}
consecutive failures. Exit codes: 0 ok (or --dry-run), 1 alert sent, 2 could not evaluate/alert.

Reference: https://bun.sh/reference/bun/dns#dns-resolver-client`;
}

export function readState(path: string): StateFile {
  const empty: StateFile = {
    schemaVersion: ENDPOINT_PROBE_STATE_SCHEMA_VERSION,
    hosts: {},
  };
  if (!existsSync(path)) return empty;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  if (
    schemaVersion !== 1 &&
    schemaVersion !== ENDPOINT_PROBE_STATE_SCHEMA_VERSION
  ) {
    throw new Error(
      `${path} schemaVersion is ${String(schemaVersion)}; expected 1 (migrated) or ${ENDPOINT_PROBE_STATE_SCHEMA_VERSION}`,
    );
  }
  const isV1 = schemaVersion === 1;
  if (
    typeof record.hosts !== "object" ||
    record.hosts === null ||
    Array.isArray(record.hosts)
  ) {
    throw new Error(`${path} has no hosts object`);
  }
  const hosts: Record<string, EndpointProbeState> = {};
  for (const [host, raw] of Object.entries(
    record.hosts as Record<string, unknown>,
  )) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${path} host "${host}" is not an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.consecutiveFailures !== "number" ||
      !Number.isFinite(entry.consecutiveFailures) ||
      entry.consecutiveFailures < 0
    ) {
      throw new Error(
        `${path} host "${host}" has an invalid consecutiveFailures`,
      );
    }
    if (
      entry.lastCheckedAtMs !== null &&
      (typeof entry.lastCheckedAtMs !== "number" ||
        !Number.isFinite(entry.lastCheckedAtMs))
    ) {
      throw new Error(`${path} host "${host}" has an invalid lastCheckedAtMs`);
    }
    const consecutiveFailures = Math.trunc(entry.consecutiveFailures);
    if (!isV1 && typeof entry.alerted !== "boolean") {
      throw new Error(`${path} host "${host}" has an invalid alerted`);
    }
    hosts[host] = {
      consecutiveFailures,
      lastCheckedAtMs: entry.lastCheckedAtMs as number | null,
      // v1 had no `alerted`; infer it so an already-down host does not re-page on upgrade.
      alerted: isV1
        ? consecutiveFailures >= ENDPOINT_PROBE_DEFAULT_FAIL_THRESHOLD
        : (entry.alerted as boolean),
    };
  }
  return { schemaVersion: ENDPOINT_PROBE_STATE_SCHEMA_VERSION, hosts };
}

function writeState(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function buildLookupOptions(
  port: number,
  backend: ProbeBackend,
): DnsLookupOptions {
  return {
    // `default` must leave the backend absent, not set to a sentinel string: Bun's platform
    // default is the path the app's fetch()/Bun.connect() takes.
    ...(backend === DEFAULT_DNS_BACKEND ? {} : { backend }),
    port,
    socketType: "tcp",
  };
}

async function resolveWithTimeout(
  host: string,
  port: number,
  backend: ProbeBackend,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveHost(host, buildLookupOptions(port, backend)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`lookup timeout after ${LOOKUP_TIMEOUT_MS}ms`)),
          LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failedObservation(
  target: HostTarget,
  error: string,
): EndpointProbeObservation {
  return {
    target,
    lookup: { ok: false, addresses: [], ttlSeconds: [], error },
    fetch: { ok: false, status: null, latencyMs: null, error },
    cacheStats: null,
  };
}

/** Bracket IPv6 for a URL authority; IPv4 is unchanged. */
export function formatIpForUrl(ip: string): string {
  return isIP(ip) === 6 ? `[${ip}]` : ip;
}

/** ALPN wire format: [length, bytes] per protocol. Bun rejects a comma-joined string. */
function alpnWire(protocols: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const protocol of protocols) {
    const bytes = Buffer.from(protocol, "utf8");
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  return Buffer.concat(parts);
}

export async function probeWebSocket(
  href: string,
  hostname: string,
  secure: boolean,
): Promise<EndpointProbeFetch> {
  const started = performance.now();
  return await new Promise<EndpointProbeFetch>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    const finish = (result: EndpointProbeFetch): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed; nothing to do
      }
      resolve(result);
    };
    try {
      socket = new WebSocket(
        href,
        secure
          ? {
              tls: {
                serverName: hostname,
                rejectUnauthorized: true,
              },
            }
          : undefined,
      );
    } catch (error) {
      resolve({
        ok: false,
        status: null,
        latencyMs: Math.round(performance.now() - started),
        error: messageOf(error),
      });
      return;
    }
    timer = setTimeout(
      () =>
        finish({
          ok: false,
          status: null,
          latencyMs: Math.round(performance.now() - started),
          error: `WebSocket timeout after ${PROBE_TIMEOUT_MS}ms`,
        }),
      PROBE_TIMEOUT_MS,
    );
    socket.addEventListener("open", () =>
      finish({
        ok: true,
        status: 101,
        latencyMs: Math.round(performance.now() - started),
        error: null,
      }),
    );
    socket.addEventListener("error", () =>
      finish({
        ok: false,
        status: null,
        latencyMs: Math.round(performance.now() - started),
        error: "WebSocket error before open",
      }),
    );
    socket.addEventListener("close", () =>
      finish({
        ok: false,
        status: null,
        latencyMs: Math.round(performance.now() - started),
        error: "WebSocket closed before open",
      }),
    );
  });
}

async function probeTlsSafe(
  host: string,
  port: number,
  servername: string,
  httpVersion: HttpVersion,
): Promise<{ tls: TlsProvenance | null; tlsError: string | null }> {
  if (httpVersion === "http3") {
    return {
      tls: null,
      tlsError:
        "HTTP/3 is QUIC; the TCP TLS provenance probe is not applicable",
    };
  }
  const alpn =
    httpVersion === "http2"
      ? ["h2"]
      : httpVersion === "http1.1"
        ? ["http/1.1"]
        : ["h2", "http/1.1"];
  try {
    return {
      tls: await probeTls({
        host,
        port,
        servername,
        timeoutMs: PROBE_TIMEOUT_MS,
        // Offer the ALPN set matching the requested HTTP version (auto offers both).
        alpnProtocols: alpnWire(alpn),
      }),
      tlsError: null,
    };
  } catch (error) {
    return { tls: null, tlsError: messageOf(error) };
  }
}

async function fetchAddress(
  target: HostTarget,
  address: string,
  httpVersion: HttpVersion,
): Promise<AddressProbe> {
  const started = performance.now();
  const family = isIP(address) === 6 ? 6 : 4;
  const tlsPromise = probeTlsSafe(
    address,
    target.port,
    target.hostname,
    httpVersion,
  );
  try {
    const response = await fetch(
      `https://${formatIpForUrl(address)}:${target.port}/`,
      {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: {
          "user-agent": "sportsdesk-endpoint-probe/1",
          host: target.hostname,
        },
        // fetch's TLS field is `serverName` (BunFetchRequestInitTLS). `servername` is the
        // node:tls alias; `serverName` wins if both are set. `hostname` is the dial/URL host,
        // not a TLS field — the HTTP Host header is separate and set above. Certificate
        // verification uses this serverName.
        tls: {
          serverName: target.hostname,
          rejectUnauthorized: true,
        } satisfies BunFetchRequestInitTLS,
        ...(httpVersion === "auto" ? {} : { protocol: httpVersion }),
      },
    );
    return {
      address,
      family,
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      error: null,
      ...(await tlsPromise),
    };
  } catch (error) {
    return {
      address,
      family,
      status: null,
      latencyMs: Math.round(performance.now() - started),
      error: messageOf(error),
      ...(await tlsPromise),
    };
  }
}

async function probe(
  target: HostTarget,
  backend: ProbeBackend,
  ipOverride: string | undefined,
  allIps: boolean,
  httpVersion: HttpVersion,
): Promise<ProbeResult> {
  let resolvedAnswers: DnsAnswer[] = [];
  const lookup = await (async () => {
    try {
      const answers = await resolveWithTimeout(
        target.hostname,
        target.port,
        backend,
      );
      resolvedAnswers = answers;
      const addresses = answers.map((answer) => answer.address);
      const ttlSeconds = answers.map((answer) => Number(answer.ttl));
      return {
        ok: addresses.length > 0,
        addresses,
        ttlSeconds,
        error: addresses.length > 0 ? null : "no addresses returned",
      };
    } catch (error) {
      return {
        ok: false,
        addresses: [],
        ttlSeconds: [],
        error: messageOf(error),
      };
    }
  })();

  // Bun DNS reference (https://bun.sh/reference/bun/dns/prefetch): prefetch warms a later fetch()/Bun.connect() so it can skip the
  // lookup (measured: prefetch miss -> fetch cache hit). Experimental, so it never decides
  // the verdict; the lookup above is the DNS signal. Skip it when dialing an explicit IP —
  // there is no name to prefetch.
  if (ipOverride === undefined) {
    Bun.dns.prefetch(target.hostname, target.port);
  }

  const tlsPromise = probeTlsSafe(
    ipOverride ?? target.hostname,
    target.port,
    target.hostname,
    httpVersion,
  );

  const started = performance.now();
  const fetched = await (async () => {
    try {
      const fetchHost =
        ipOverride === undefined ? target.hostname : formatIpForUrl(ipOverride);
      const response = await fetch(`https://${fetchHost}:${target.port}/`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: {
          "user-agent": "sportsdesk-endpoint-probe/1",
          // Keep the logical Host when dialing an explicit IP.
          ...(ipOverride === undefined ? {} : { host: target.hostname }),
        },
        // fetch's TLS field is `serverName` (typed by BunFetchRequestInitTLS); `servername`
        // is the node:tls alias and serverName wins. `hostname` is the dial/URL host, not a
        // TLS field. Verification uses the logical hostname even when the URL host is an IP.
        tls: {
          // Pin verification regardless of environment overrides.
          rejectUnauthorized: true,
          ...(ipOverride === undefined ? {} : { serverName: target.hostname }),
        },
        ...(httpVersion === "auto" ? {} : { protocol: httpVersion }),
      });
      return {
        ok: true,
        status: response.status,
        latencyMs: Math.round(performance.now() - started),
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        latencyMs: Math.round(performance.now() - started),
        error: messageOf(error),
      };
    }
  })();

  // Address probes are opt-in via --all-ips; the primary fetch already covers --ip alone.
  const addressProbes = allIps
    ? await Promise.all(
        [
          ...new Set([
            ...(ipOverride === undefined ? [] : [ipOverride]),
            ...resolvedAnswers.map((answer) => answer.address),
          ]),
        ].map((address) => fetchAddress(target, address, httpVersion)),
      )
    : [];

  return {
    observation: {
      target,
      lookup,
      fetch: fetched,
      cacheStats: readDnsCacheStats() ?? null,
    },
    addressProbes,
    ...(await tlsPromise),
  };
}

async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
        // The bot token is sensitive; never let an env var disable verification here.
        tls: { rejectUnauthorized: true },
      },
    );
    const body = (await response.json()) as {
      ok?: boolean;
      description?: string;
    };
    if (response.ok && body.ok === true) return { ok: true, detail: "sent" };
    return {
      ok: false,
      detail: `http ${response.status}${body.description === undefined ? "" : `: ${body.description}`}`,
    };
  } catch (error) {
    return { ok: false, detail: messageOf(error) };
  }
}

export function renderJson(
  nowMs: number,
  dryRun: boolean,
  resolver: ProbeBackend,
  verdicts: readonly EndpointProbeVerdict[],
  ip: string | null,
  allIps: boolean,
  addressProbesByHost: Readonly<Record<string, readonly AddressProbe[]>>,
  tlsByHost: Readonly<
    Record<string, { tls: TlsProvenance | null; tlsError: string | null }>
  >,
  httpVersion: HttpVersion,
): ProbeJson {
  return {
    schemaVersion: 1,
    checkedAt: new Date(nowMs).toISOString(),
    intervalSeconds: ENDPOINT_PROBE_INTERVAL_SECONDS,
    dryRun,
    resolver,
    socketType: "tcp",
    ip,
    allIps,
    httpVersion,
    mode: "http",
    wsUrl: null,
    alerts: verdicts.filter((verdict) => verdict.status === "alert").length,
    hosts: verdicts.map((verdict) => ({
      host: verdict.target.hostname,
      service: verdict.target.serviceName,
      port: verdict.target.port,
      status: verdict.status,
      code: verdict.code,
      consecutiveFailures: verdict.consecutiveFailures,
      message: verdict.message,
      addresses: verdict.addresses,
      ttlSeconds: verdict.ttlSeconds,
      addressProbes: addressProbesByHost[verdict.target.hostname] ?? [],
      tls: tlsByHost[verdict.target.hostname]?.tls ?? null,
      tlsError: tlsByHost[verdict.target.hostname]?.tlsError ?? null,
      fetchStatus: verdict.fetchStatus,
      latencyMs: verdict.latencyMs,
      cacheStats: verdict.cacheStats,
    })),
  };
}

export function renderWsJson(
  nowMs: number,
  verdict: EndpointProbeVerdict,
  resolver: ProbeBackend,
  tls: { tls: TlsProvenance | null; tlsError: string | null },
  wsUrl: string,
): ProbeJson {
  const base = renderJson(
    nowMs,
    true,
    resolver,
    [verdict],
    null,
    false,
    {},
    { [verdict.target.hostname]: tls },
    "auto",
  );
  return { ...base, mode: "websocket", wsUrl };
}

export function buildNextState(
  state: StateFile,
  verdicts: readonly EndpointProbeVerdict[],
  alertedByHost: Readonly<Record<string, boolean>>,
): StateFile {
  const nextHosts: Record<string, EndpointProbeState> = {};
  for (const verdict of verdicts) {
    nextHosts[verdict.target.hostname] = {
      consecutiveFailures: verdict.consecutiveFailures,
      lastCheckedAtMs: verdict.checkedAtMs,
      alerted:
        alertedByHost[verdict.target.hostname] ?? verdict.status === "alert",
    };
  }
  // Keep state for core hosts not selected by --host; prune entries for retired hosts so the
  // file cannot grow without bound.
  for (const [host, hostState] of Object.entries(state.hosts)) {
    if (
      nextHosts[host] === undefined &&
      SPORTSDESK_CORE_HOSTS.some((target) => target.hostname === host)
    ) {
      nextHosts[host] = hostState;
    }
  }
  return {
    schemaVersion: ENDPOINT_PROBE_STATE_SCHEMA_VERSION,
    hosts: nextHosts,
  };
}

export interface PagingDecision {
  readonly newAlerts: readonly EndpointProbeVerdict[];
  readonly recoveries: readonly EndpointProbeVerdict[];
  readonly nextAlerted: Readonly<Record<string, boolean>>;
}

/**
 * Page on the transition only: a host that stays down keeps `alerted: true` and does not page
 * again; a healthy host that was alerted produces one recovery. A below-threshold failure after
 * an alert is neither healthy nor a new alert, so it keeps the prior alerted state.
 */
export function classifyPaging(
  state: StateFile,
  verdicts: readonly EndpointProbeVerdict[],
): PagingDecision {
  const newAlerts: EndpointProbeVerdict[] = [];
  const recoveries: EndpointProbeVerdict[] = [];
  const nextAlerted: Record<string, boolean> = {};
  for (const verdict of verdicts) {
    const host = verdict.target.hostname;
    const prior = state.hosts[host]?.alerted ?? false;
    const alerting = verdict.status === "alert";
    const healthy = verdict.status === "ok" && verdict.code === null;
    if (alerting && !prior) newAlerts.push(verdict);
    if (healthy && prior) recoveries.push(verdict);
    nextAlerted[host] = alerting ? true : healthy ? false : prior;
  }
  return { newAlerts, recoveries, nextAlerted };
}

export function selectTargets(requested: readonly string[]): HostTarget[] {
  const wanted = new Set(requested.map((host) => host.toLowerCase()));
  const targets = SPORTSDESK_CORE_HOSTS.filter(
    (target) => wanted.size === 0 || wanted.has(target.hostname.toLowerCase()),
  );
  if (wanted.size > 0 && targets.length !== wanted.size) {
    const known = SPORTSDESK_CORE_HOSTS.map((target) => target.hostname).join(
      ", ",
    );
    throw new Error(`unknown --host (allowed: ${known})`);
  }
  return targets;
}

async function run(): Promise<number> {
  const options = parseOptions();
  if (options.help) {
    console.log(usage());
    return EXIT.ok;
  }

  if (options.wsUrl !== undefined) {
    const url = new URL(options.wsUrl);
    const secure = url.protocol === "wss:";
    const rawHost = url.hostname;
    const hostname =
      rawHost.startsWith("[") && rawHost.endsWith("]")
        ? rawHost.slice(1, -1)
        : rawHost;
    const port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
    const target: HostTarget = {
      hostname,
      port,
      serviceName: "WebSocket diagnostic",
    };
    const lookup = await (async () => {
      try {
        const answers = await resolveWithTimeout(
          hostname,
          port,
          options.backend,
        );
        const addresses = answers.map((answer) => answer.address);
        return {
          ok: addresses.length > 0,
          addresses,
          ttlSeconds: answers.map((answer) => Number(answer.ttl)),
          error: addresses.length > 0 ? null : "no addresses returned",
        };
      } catch (error) {
        return {
          ok: false,
          addresses: [],
          ttlSeconds: [],
          error: messageOf(error),
        };
      }
    })();
    const handshake = await probeWebSocket(url.href, hostname, secure);
    const tls = secure
      ? await probeTlsSafe(hostname, port, hostname, "http1.1")
      : { tls: null, tlsError: "ws:// is plaintext (no TLS)" };
    const nowMs = Date.now();
    const verdict = evaluateEndpointProbe({
      nowMs,
      state: { consecutiveFailures: 0, lastCheckedAtMs: null, alerted: false },
      observation: {
        target,
        lookup,
        fetch: handshake,
        transport: "websocket",
        cacheStats: readDnsCacheStats() ?? null,
      },
    });
    if (options.json) {
      console.log(
        JSON.stringify(
          renderWsJson(nowMs, verdict, options.backend, tls, url.href),
          null,
          2,
        ),
      );
    } else {
      console.log(`WebSocket: ${url.href}`);
      console.log(verdict.message);
    }
    return EXIT.ok;
  }

  const baseTargets = selectTargets(options.hosts);
  const portOverride = options.port;
  const targets =
    portOverride === undefined
      ? baseTargets
      : baseTargets.map((target) => ({ ...target, port: portOverride }));
  const state = readState(options.statePath);
  const nowMs = Date.now();
  const settled = await Promise.allSettled(
    targets.map((target) =>
      probe(
        target,
        options.backend,
        options.ip,
        options.allIps,
        options.httpVersion,
      ),
    ),
  );
  const addressProbesByHost: Record<string, readonly AddressProbe[]> = {};
  const tlsByHost: Record<
    string,
    { tls: TlsProvenance | null; tlsError: string | null }
  > = {};
  const observations = settled.map((result, index) => {
    const target = targets[index];
    if (target === undefined) {
      throw new Error("endpoint probe: target mapping lost");
    }
    if (result.status === "fulfilled") {
      addressProbesByHost[target.hostname] = result.value.addressProbes;
      tlsByHost[target.hostname] = {
        tls: result.value.tls,
        tlsError: result.value.tlsError,
      };
      return result.value.observation;
    }
    addressProbesByHost[target.hostname] = [];
    tlsByHost[target.hostname] = {
      tls: null,
      tlsError: messageOf(result.reason),
    };
    return failedObservation(target, messageOf(result.reason));
  });
  const verdicts = observations.map((observation) =>
    evaluateEndpointProbe({
      nowMs,
      state: state.hosts[observation.target.hostname] ?? {
        consecutiveFailures: 0,
        lastCheckedAtMs: null,
        alerted: false,
      },
      observation,
    }),
  );

  if (options.json) {
    console.log(
      JSON.stringify(
        renderJson(
          nowMs,
          options.dryRun,
          options.backend,
          verdicts,
          options.ip ?? null,
          options.allIps,
          addressProbesByHost,
          tlsByHost,
          options.httpVersion,
        ),
        null,
        2,
      ),
    );
  } else {
    console.log(
      `DNS resolver: ${options.backend === DEFAULT_DNS_BACKEND ? "Bun default" : options.backend}`,
    );
    for (const verdict of verdicts) console.log(verdict.message);
    const alerts = verdicts.filter((verdict) => verdict.status === "alert");
    if (alerts.length > 0) {
      console.log(
        `\n${alerts.length} alert(s) after two consecutive failures.`,
      );
    }
  }

  const decision = classifyPaging(state, verdicts);
  if (options.dryRun) return EXIT.ok;

  const alertedByHost: Record<string, boolean> = { ...decision.nextAlerted };
  const pages = decision.newAlerts.length + decision.recoveries.length;
  const keepUnacknowledged = (): void => {
    // A failed page must not mark the transition as delivered, or the next tick would skip it.
    for (const verdict of decision.newAlerts) {
      alertedByHost[verdict.target.hostname] =
        state.hosts[verdict.target.hostname]?.alerted ?? false;
    }
    for (const verdict of decision.recoveries) {
      alertedByHost[verdict.target.hostname] = true;
    }
  };
  if (pages === 0) {
    writeState(
      options.statePath,
      buildNextState(state, verdicts, alertedByHost),
    );
    return EXIT.ok;
  }

  const credentials = await resolveTelegramCredentials();
  if (credentials.source === "none") {
    keepUnacknowledged();
    writeState(
      options.statePath,
      buildNextState(state, verdicts, alertedByHost),
    );
    console.error(
      "endpoint probe: page detected but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are unavailable",
    );
    return EXIT.error;
  }
  const text = [
    "SportsDesk endpoint watchdog",
    ...decision.newAlerts.map((verdict) => `- ALERT ${verdict.message}`),
    ...decision.recoveries.map((verdict) => `- RECOVERED ${verdict.message}`),
  ].join("\n");
  const sent = await sendTelegram(
    credentials.botToken,
    credentials.chatId,
    text,
  );
  if (!sent.ok) {
    keepUnacknowledged();
    writeState(
      options.statePath,
      buildNextState(state, verdicts, alertedByHost),
    );
    console.error(`endpoint probe: Telegram send failed (${sent.detail})`);
    return EXIT.error;
  }
  writeState(options.statePath, buildNextState(state, verdicts, alertedByHost));
  console.log(
    `endpoint probe: ${decision.newAlerts.length} alert(s), ${decision.recoveries.length} recovery(ies) sent via ${credentials.source}`,
  );
  return EXIT.alert;
}

if (import.meta.main) {
  run()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`endpoint probe: ${messageOf(error)}`);
      process.exit(EXIT.error);
    });
}
