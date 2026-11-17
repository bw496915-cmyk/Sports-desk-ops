/**
 * @file endpoint_probe.ts
 * @description Pure evaluation for the SportsDesk endpoint watchdog: per-host DNS lookup plus
 * HTTPS reachability, with two-consecutive-failure paging and cache telemetry that never gates.
 *
 * The runner (`scripts/watchdog_endpoint_probe.ts`) does the I/O — `Bun.dns.lookup`, `fetch`,
 * the state file and Telegram. Nothing here touches the network or the filesystem, so the
 * transitions and thresholds are unit-tested without a live resolver.
 *
 * Gating rule: `prefetch`/`getCacheStats` are documented Experimental APIs
 * (https://bun.sh/reference/bun/dns) that describe Bun's internal cache; they are telemetry
 * only. A verdict comes from the observable path (`Bun.dns.lookup` + the endpoint fetch): a
 * cache with errors but a reachable endpoint is still reachable.
 */

import type { HostTarget } from "../bun_dns.ts";

/** Page after this many consecutive failed probes (mirrors the F402 watchdog's rule). */
export const ENDPOINT_PROBE_DEFAULT_FAIL_THRESHOLD = 2;

/**
 * Suggested runner cadence. DNS/TLS/endpoint health degrades slower than a session heartbeat;
 * 15 minutes keeps a single resolver blip from paging. The LaunchAgent uses StartInterval 900.
 */
export const ENDPOINT_PROBE_INTERVAL_SECONDS = 15 * 60;

/** State-file schema; a different version is refused by the runner, never guessed. */
export const ENDPOINT_PROBE_STATE_SCHEMA_VERSION = 1 as const;

export type EndpointProbeFailureCode =
  "lookup-failed" | "fetch-failed" | "http-server-error";

export interface EndpointProbeLookup {
  readonly ok: boolean;
  readonly addresses: readonly string[];
  readonly error: string | null;
}

export interface EndpointProbeFetch {
  readonly ok: boolean;
  /** Any received HTTP status; null when no response was received. */
  readonly status: number | null;
  readonly latencyMs: number | null;
  readonly error: string | null;
}

export interface EndpointProbeObservation {
  readonly target: HostTarget;
  readonly lookup: EndpointProbeLookup;
  readonly fetch: EndpointProbeFetch;
  /** Telemetry only; never affects the verdict. */
  readonly cacheStats: Readonly<Record<string, number>> | null;
}

export interface EndpointProbeState {
  readonly consecutiveFailures: number;
  readonly lastCheckedAtMs: number | null;
}

export interface EndpointProbeInput {
  readonly nowMs: number;
  readonly state: EndpointProbeState;
  readonly observation: EndpointProbeObservation;
  readonly failThreshold?: number;
}

export interface EndpointProbeVerdict {
  readonly target: HostTarget;
  readonly status: "ok" | "alert";
  readonly code: EndpointProbeFailureCode | null;
  readonly consecutiveFailures: number;
  readonly checkedAtMs: number;
  readonly message: string;
  readonly addresses: readonly string[];
  readonly fetchStatus: number | null;
  readonly latencyMs: number | null;
  /** Telemetry only; never part of the verdict. */
  readonly cacheStats: Readonly<Record<string, number>> | null;
}

/**
 * A probe fails when the name does not resolve, no HTTP response was received, or the endpoint
 * answered 5xx. A 3xx/4xx is a reachable endpoint: the probe checks reachability, not whether `/`
 * is a valid route (Telegram's API root answers 404 by design).
 */
function failureOf(
  observation: EndpointProbeObservation,
): { code: EndpointProbeFailureCode; detail: string } | null {
  if (!observation.lookup.ok) {
    return {
      code: "lookup-failed",
      detail: observation.lookup.error ?? "no addresses returned",
    };
  }
  if (!observation.fetch.ok) {
    return {
      code: "fetch-failed",
      detail: observation.fetch.error ?? "no HTTP response",
    };
  }
  if (observation.fetch.status !== null && observation.fetch.status >= 500) {
    return {
      code: "http-server-error",
      detail: `HTTP ${observation.fetch.status}`,
    };
  }
  return null;
}

/** Evaluate one already-measured observation against the target's prior consecutive-failure state. */
export function evaluateEndpointProbe(
  input: EndpointProbeInput,
): EndpointProbeVerdict {
  const threshold = Math.max(
    1,
    Math.trunc(input.failThreshold ?? ENDPOINT_PROBE_DEFAULT_FAIL_THRESHOLD),
  );
  const failure = failureOf(input.observation);
  const consecutiveFailures =
    failure === null
      ? 0
      : Math.max(0, Math.trunc(input.state.consecutiveFailures)) + 1;
  const status =
    failure !== null && consecutiveFailures >= threshold ? "alert" : "ok";
  const host = input.observation.target.hostname;

  const message = (() => {
    if (failure === null) {
      const http =
        input.observation.fetch.status === null
          ? "no status"
          : `HTTP ${input.observation.fetch.status}`;
      const latency =
        input.observation.fetch.latencyMs === null
          ? ""
          : `, ${input.observation.fetch.latencyMs}ms`;
      return `${host}: ok (${http}${latency})`;
    }
    const prefix = status === "alert" ? "ALERT " : "";
    return `${prefix}${host}: ${failure.code} (${consecutiveFailures}/${threshold} consecutive failures): ${failure.detail}`;
  })();

  return {
    target: input.observation.target,
    status,
    code: failure?.code ?? null,
    consecutiveFailures,
    checkedAtMs: input.nowMs,
    message,
    addresses: input.observation.lookup.addresses,
    fetchStatus: input.observation.fetch.status,
    latencyMs: input.observation.fetch.latencyMs,
    cacheStats: input.observation.cacheStats,
  };
}
