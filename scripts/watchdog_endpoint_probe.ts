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
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  SPORTSDESK_CORE_HOSTS,
  type DnsResolverBackend,
  type HostTarget,
} from "../lib/bun_dns.ts";
import { readDnsCacheStats, resolveHost } from "../lib/preflight.ts";
import { resolveTelegramCredentials } from "../lib/telegram_alert_sender.ts";
import {
  ENDPOINT_PROBE_DEFAULT_FAIL_THRESHOLD,
  ENDPOINT_PROBE_INTERVAL_SECONDS,
  ENDPOINT_PROBE_STATE_SCHEMA_VERSION,
  evaluateEndpointProbe,
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

/** Bun DNS reference: `lookup` takes `backend`; c-ares avoids the getaddrinfo slow path. */
const DNS_BACKENDS: readonly DnsResolverBackend[] = [
  "c-ares",
  "system",
  "getaddrinfo",
  "libc",
];
const DEFAULT_DNS_BACKEND: DnsResolverBackend = "c-ares";

interface Options {
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly hosts: readonly string[];
  readonly backend: DnsResolverBackend;
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
  readonly resolver: DnsResolverBackend;
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
    readonly fetchStatus: number | null;
    readonly latencyMs: number | null;
    readonly cacheStats: Readonly<Record<string, number>> | null;
  }[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseBackend(raw: string | undefined): DnsResolverBackend {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DNS_BACKEND;
  const backend = DNS_BACKENDS.find((candidate) => candidate === raw.trim());
  if (backend === undefined) {
    throw new Error(
      `invalid --backend "${raw}" (allowed: ${DNS_BACKENDS.join(", ")})`,
    );
  }
  return backend;
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
      state: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    json: values.json ?? false,
    dryRun: values["dry-run"] ?? false,
    hosts: values.host ?? [],
    backend: parseBackend(values.backend),
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
  --backend <name>    DNS resolver: c-ares (default) | system | getaddrinfo | libc.
                      c-ares avoids the documented getaddrinfo slow path under concurrent loads.
  --state <path>      State file (default: scratch/watchdog/endpoint-probe-state.json).
  --dry-run           Probe and print, but do not write state or page Telegram.
  --json              Print one JSON object on stdout.
  -h, --help          Show this help.

Cadence: LaunchAgent StartInterval 900 (15 min); pages after ${ENDPOINT_PROBE_DEFAULT_FAIL_THRESHOLD}
consecutive failures. Exit codes: 0 ok (or --dry-run), 1 alert sent, 2 could not evaluate/alert.`;
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
  if (record.schemaVersion !== ENDPOINT_PROBE_STATE_SCHEMA_VERSION) {
    throw new Error(
      `${path} schemaVersion is ${String(record.schemaVersion)}; expected ${ENDPOINT_PROBE_STATE_SCHEMA_VERSION}`,
    );
  }
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
    hosts[host] = {
      consecutiveFailures: Math.trunc(entry.consecutiveFailures),
      lastCheckedAtMs: entry.lastCheckedAtMs as number | null,
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

async function resolveWithTimeout(host: string, backend: DnsResolverBackend) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveHost(host, {
        // Default c-ares: the Bun DNS reference warns that getaddrinfo is the slow path
        // under concurrent loads, and this probe resolves every core host in parallel.
        // --backend overrides this for diagnostics. Omit family so an IPv4-only host still
        // resolves (c-ares does not honor V4MAPPED; family 6 + flags returned AAAA only).
        backend,
      }),
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

async function probe(
  target: HostTarget,
  backend: DnsResolverBackend,
): Promise<EndpointProbeObservation> {
  const lookup = await (async () => {
    try {
      const answers = await resolveWithTimeout(target.hostname, backend);
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

  // Bun DNS reference: prefetch warms a later fetch()/Bun.connect() so it can skip the
  // lookup (measured: prefetch miss -> fetch cache hit). Experimental, so it never decides
  // the verdict; the lookup above is the DNS signal.
  Bun.dns.prefetch(target.hostname, target.port);

  const started = performance.now();
  const fetched = await (async () => {
    try {
      const response = await fetch(
        `https://${target.hostname}:${target.port}/`,
        {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          headers: { "user-agent": "sportsdesk-endpoint-probe/1" },
        },
      );
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

  return {
    target,
    lookup,
    fetch: fetched,
    cacheStats: readDnsCacheStats() ?? null,
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
  resolver: DnsResolverBackend,
  verdicts: readonly EndpointProbeVerdict[],
): ProbeJson {
  return {
    schemaVersion: 1,
    checkedAt: new Date(nowMs).toISOString(),
    intervalSeconds: ENDPOINT_PROBE_INTERVAL_SECONDS,
    dryRun,
    resolver,
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
      fetchStatus: verdict.fetchStatus,
      latencyMs: verdict.latencyMs,
      cacheStats: verdict.cacheStats,
    })),
  };
}

export function buildNextState(
  state: StateFile,
  verdicts: readonly EndpointProbeVerdict[],
): StateFile {
  const nextHosts: Record<string, EndpointProbeState> = {};
  for (const verdict of verdicts) {
    nextHosts[verdict.target.hostname] = {
      consecutiveFailures: verdict.consecutiveFailures,
      lastCheckedAtMs: verdict.checkedAtMs,
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

  const targets = selectTargets(options.hosts);
  const state = readState(options.statePath);
  const nowMs = Date.now();
  const settled = await Promise.allSettled(
    targets.map((target) => probe(target, options.backend)),
  );
  const observations = settled.map((result, index) => {
    const target = targets[index];
    if (target === undefined) {
      throw new Error("endpoint probe: target mapping lost");
    }
    return result.status === "fulfilled"
      ? result.value
      : failedObservation(target, messageOf(result.reason));
  });
  const verdicts = observations.map((observation) =>
    evaluateEndpointProbe({
      nowMs,
      state: state.hosts[observation.target.hostname] ?? {
        consecutiveFailures: 0,
        lastCheckedAtMs: null,
      },
      observation,
    }),
  );

  if (options.json) {
    console.log(
      JSON.stringify(
        renderJson(nowMs, options.dryRun, options.backend, verdicts),
        null,
        2,
      ),
    );
  } else {
    console.log(`DNS resolver: ${options.backend}`);
    for (const verdict of verdicts) console.log(verdict.message);
    const alerts = verdicts.filter((verdict) => verdict.status === "alert");
    if (alerts.length > 0) {
      console.log(
        `\n${alerts.length} alert(s) after two consecutive failures.`,
      );
    }
  }

  if (options.dryRun) return EXIT.ok;

  writeState(options.statePath, buildNextState(state, verdicts));

  const alerts = verdicts.filter((verdict) => verdict.status === "alert");
  if (alerts.length === 0) return EXIT.ok;

  const credentials = await resolveTelegramCredentials();
  if (credentials.source === "none") {
    console.error(
      "endpoint probe: alert detected but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are unavailable",
    );
    return EXIT.error;
  }
  const text = [
    "SportsDesk endpoint watchdog — alert",
    ...alerts.map((verdict) => `- ${verdict.message}`),
  ].join("\n");
  const sent = await sendTelegram(
    credentials.botToken,
    credentials.chatId,
    text,
  );
  if (!sent.ok) {
    console.error(`endpoint probe: Telegram send failed (${sent.detail})`);
    return EXIT.error;
  }
  console.log(`endpoint probe: alert sent via ${credentials.source}`);
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
