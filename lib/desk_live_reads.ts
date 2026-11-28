/**
 * @file desk_live_reads.ts
 * @description Live-first orchestration for desk ticker (`getBetTicker`) and Pending reads:
 * route resolution, TTL caches, artifact persistence, refresh-loop telemetry, and `/api/status`
 * live blocks.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { F402ProbeFetch } from "./f402_ingest.ts";
import {
  fetchLivePending,
  pendingCustomersFromTickerRows,
  REPORT_PENDING_OPERATION,
  type LivePendingDiagnostic,
} from "./f402_live_pending.ts";
import {
  fetchLiveBetTicker,
  type LiveTickerDiagnostic,
} from "./f402_live_ticker.ts";
import type { F402Session } from "./f402_session.ts";
import {
  LIVE_PENDING_DEFAULT_TTL_MS,
  LIVE_PENDING_MAX_TTL_MS,
  LIVE_PERSIST_DEFAULT_THROTTLE_MS,
  LIVE_REFRESH_DEFAULT_MS,
  LIVE_REFRESH_MAX_MS,
  LIVE_TICKER_DEFAULT_TIMEOUT_MS,
  LIVE_TICKER_DEFAULT_TTL_MS,
  LIVE_TICKER_MAX_TIMEOUT_MS,
  LIVE_TICKER_MAX_TTL_MS,
  LIVE_TICKER_MIN_TIMEOUT_MS,
} from "./live_read_defaults.ts";
import {
  LIVE_PENDING_DEFAULT_MAX_CUSTOMERS,
  LIVE_PENDING_DEFAULT_TIMEOUT_MS,
  LIVE_PENDING_MAX_MAX_CUSTOMERS,
  LIVE_PENDING_MAX_TIMEOUT_MS,
  LIVE_PENDING_MIN_TIMEOUT_MS,
} from "./f402_live_pending.ts";
import {
  livePendingArtifact,
  type LiveBetsArtifact,
  type LiveBetsSummary,
} from "./live_bets.ts";
import { resolveLiveBets } from "../src/live_bets/resolve.ts";
import {
  BET_TICKER_OPERATION,
  liveTickerFile,
  readWagerListArtifact,
  type WagerListArtifact,
} from "./live_wagers.ts";
import {
  persistLiveSnapshot,
  type LivePersistState,
} from "./live_provenance.ts";
import { freshness, STALE_AFTER_SECONDS, type KpiInput } from "./desk_kpis.ts";
import { createStateMachine, defineStateGraph } from "./state_machine.ts";

export const LIVE_FEED_CACHE_STATES = [
  "cold",
  "fetching",
  "fresh",
  "degraded",
] as const;
export type LiveFeedCacheStateKind = (typeof LIVE_FEED_CACHE_STATES)[number];

export const LIVE_FEED_CACHE_GRAPH = defineStateGraph(
  "DeskLiveFeedCache",
  LIVE_FEED_CACHE_STATES,
  {
    cold: ["fetching"],
    fetching: ["fetching", "fresh", "degraded"],
    fresh: ["fetching"],
    degraded: ["fetching"],
  },
);

export const LIVE_REFRESH_LOOP_STATES = [
  "disabled",
  "idle",
  "in_flight",
  "stopped",
] as const;
export type LiveRefreshLoopStateKind =
  (typeof LIVE_REFRESH_LOOP_STATES)[number];

export const LIVE_REFRESH_LOOP_GRAPH = defineStateGraph(
  "DeskLiveRefreshLoop",
  LIVE_REFRESH_LOOP_STATES,
  {
    disabled: ["idle"],
    idle: ["in_flight", "stopped"],
    in_flight: ["idle", "stopped"],
    stopped: ["idle"],
  },
);

export type LiveSourceMode = "auto" | "live" | "file";

export interface LiveDiagnosticBody {
  readonly code: string;
  readonly message?: string;
  readonly hint?: string;
  readonly httpStatus?: number;
}

export interface LiveTickerStatusBody {
  readonly mode: LiveSourceMode;
  readonly status: "live" | "unavailable" | "disabled";
  readonly ok: boolean;
  readonly fetchedAt: string | null;
  readonly servedFromCache: boolean;
  readonly transport: string | null;
  readonly diagnostic: LiveDiagnosticBody | null;
  readonly ttlMs: number;
}

export type LivePendingScopeSource = "env" | "ticker" | "none";

export interface LivePendingStatusBody extends LiveTickerStatusBody {
  /** Where the fan-out scope came from; `none` is the actionable 503 case. */
  readonly scopeSource: LivePendingScopeSource;
  readonly customersAttempted: number;
  readonly customersFailed: number;
}

export interface LiveRefreshTelemetry {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly ticks: number;
  readonly lastTickAt: string | null;
  readonly lastTickOk: boolean | null;
  readonly lastError: string | null;
}

export interface LivePersistenceTelemetry {
  readonly enabled: boolean;
  readonly artifactRoot: "repo" | "custom";
  readonly throttleMs: number;
}

export interface LiveStatusBlock {
  readonly ticker: LiveTickerStatusBody | null;
  readonly pending: LivePendingStatusBody | null;
  readonly refresh: LiveRefreshTelemetry;
  readonly persistence: LivePersistenceTelemetry;
}

export interface LiveTickerServerOptions {
  readonly enabled?: boolean;
  readonly fetch?: F402ProbeFetch;
  readonly session?: F402Session | null;
  readonly agentId?: string;
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
}

export interface LivePendingPersistenceOptions {
  readonly enabled?: boolean;
  readonly rootDir?: string;
  readonly throttleMs?: number;
}

export interface LivePendingServerOptions {
  readonly enabled?: boolean;
  readonly fetch?: F402ProbeFetch;
  readonly session?: F402Session | null;
  readonly customers?: readonly string[];
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
  readonly maxCustomers?: number;
  readonly persistence?: LivePendingPersistenceOptions;
}

export interface LiveRefreshOptions {
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly jitterMs?: number;
  readonly onStarted?: (stop: () => void) => void;
}

export interface DeskLiveReadsOptions {
  readonly repoRoot: string;
  readonly liveBetsPath: string;
  readonly wagerListDir: string;
  readonly liveTicker?: LiveTickerServerOptions;
  readonly livePending?: LivePendingServerOptions;
  readonly liveRefresh?: LiveRefreshOptions;
  /** When true, the daemon may start the refresh loop from env unless overridden. */
  readonly daemonEntry?: boolean;
  readonly loadWagerList?: () => Promise<{
    readonly chosen: {
      readonly path: string;
      readonly artifact: WagerListArtifact;
      readonly mtime: Date;
    } | null;
    readonly skipped: ReadonlyArray<{ path: string; reason: string }>;
  }>;
}

export interface LiveBetsServeResult {
  readonly httpStatus: number;
  readonly body: Record<string, unknown>;
  readonly etagParts?: string;
}

export interface LiveWagersServeResult {
  readonly httpStatus: number;
  readonly body: Record<string, unknown>;
}

interface TickerCacheEntry {
  readonly status: LiveTickerStatusBody;
  readonly artifact: WagerListArtifact | null;
  readonly rawPayload: unknown | null;
}

interface PendingCacheEntry {
  readonly status: LivePendingStatusBody;
  readonly artifact: LiveBetsArtifact | null;
}

const LIVE_TICKER_GATE = "SPORTSDESK_LIVE_TICKER";
const LIVE_PENDING_GATE = "SPORTSDESK_LIVE_PENDING";
const LIVE_PERSIST_GATE = "SPORTSDESK_LIVE_PERSIST";
const LIVE_PERSIST_ROOT_ENV = "SPORTSDESK_LIVE_PERSIST_ROOT";
const LIVE_REFRESH_ENV = "SPORTSDESK_LIVE_REFRESH_MS";
const LIVE_TICKER_TTL_ENV = "SPORTSDESK_LIVE_TICKER_TTL_MS";
const LIVE_TICKER_TIMEOUT_ENV = "SPORTSDESK_LIVE_TICKER_TIMEOUT_MS";
const LIVE_PENDING_TTL_ENV = "SPORTSDESK_LIVE_PENDING_TTL_MS";
const LIVE_PENDING_TIMEOUT_ENV = "SPORTSDESK_LIVE_PENDING_TIMEOUT_MS";
const LIVE_PENDING_CUSTOMERS_ENV = "SPORTSDESK_LIVE_PENDING_CUSTOMERS";
const LIVE_PENDING_MAX_CUSTOMERS_ENV = "SPORTSDESK_LIVE_PENDING_MAX_CUSTOMERS";
const LIVE_PERSIST_MS_ENV = "SPORTSDESK_LIVE_PERSIST_MS";

const OFF = new Set(["0", "false", "off", "no"]);
const ON = new Set(["1", "true", "on", "yes"]);

function envFlag(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): boolean | undefined {
  const raw = (env[key] ?? "").trim().toLowerCase();
  if (raw === "") return undefined;
  if (OFF.has(raw)) return false;
  if (ON.has(raw)) return true;
  return undefined;
}

function gateEnabled(
  explicit: boolean | undefined,
  env: Readonly<Record<string, string | undefined>>,
  gateVar: string,
): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const fromEnv = envFlag(env, gateVar);
  if (fromEnv !== undefined) return fromEnv;
  return (env.NODE_ENV ?? "").trim() !== "test";
}

function clampMs(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function parseCustomers(
  env: Readonly<Record<string, string | undefined>>,
  explicit?: readonly string[],
): string[] {
  if (explicit !== undefined) return [...explicit];
  const raw = (env[LIVE_PENDING_CUSTOMERS_ENV] ?? "").trim();
  if (raw === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function toDiagnostic(
  diagnostic: LiveTickerDiagnostic | LivePendingDiagnostic,
): LiveDiagnosticBody | null {
  if (diagnostic.code === "ok") return null;
  return {
    code: diagnostic.code,
    ...("message" in diagnostic && typeof diagnostic.message === "string"
      ? { message: diagnostic.message }
      : {}),
    ...("hint" in diagnostic && typeof diagnostic.hint === "string"
      ? { hint: diagnostic.hint }
      : {}),
    ...("httpStatus" in diagnostic && typeof diagnostic.httpStatus === "number"
      ? { httpStatus: diagnostic.httpStatus }
      : {}),
  };
}

function disabledTickerStatus(
  mode: LiveSourceMode,
  ttlMs: number,
): LiveTickerStatusBody {
  return {
    mode,
    status: "disabled",
    ok: false,
    fetchedAt: null,
    servedFromCache: false,
    transport: null,
    diagnostic: null,
    ttlMs,
  };
}

function disabledPendingStatus(
  mode: LiveSourceMode,
  ttlMs: number,
): LivePendingStatusBody {
  return {
    ...disabledTickerStatus(mode, ttlMs),
    scopeSource: "none",
    customersAttempted: 0,
    customersFailed: 0,
  };
}

export function parseLiveSourceMode(
  raw: string | null,
): LiveSourceMode | "invalid" {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "live";
  if (value === "auto" || value === "live" || value === "file") return value;
  return "invalid";
}

export function createDeskLiveReads(options: DeskLiveReadsOptions) {
  const tickerOpt = options.liveTicker ?? {};
  const pendingOpt = options.livePending ?? {};
  const tickerEnv = tickerOpt.env ?? Bun.env;
  const pendingEnv = pendingOpt.env ?? Bun.env;
  const tickerNow = tickerOpt.now ?? (() => new Date());
  const pendingNow = pendingOpt.now ?? tickerNow;

  const tickerGateOn = gateEnabled(
    tickerOpt.enabled,
    tickerEnv,
    LIVE_TICKER_GATE,
  );
  const pendingGateOn = gateEnabled(
    pendingOpt.enabled,
    pendingEnv,
    LIVE_PENDING_GATE,
  );

  const tickerTtlMs = clampMs(
    tickerOpt.ttlMs === undefined
      ? tickerEnv[LIVE_TICKER_TTL_ENV]
      : String(tickerOpt.ttlMs),
    LIVE_TICKER_DEFAULT_TTL_MS,
    0,
    LIVE_TICKER_MAX_TTL_MS,
  );
  const pendingTtlMs = clampMs(
    pendingOpt.ttlMs === undefined
      ? pendingEnv[LIVE_PENDING_TTL_ENV]
      : String(pendingOpt.ttlMs),
    LIVE_PENDING_DEFAULT_TTL_MS,
    0,
    LIVE_PENDING_MAX_TTL_MS,
  );

  const tickerTimeoutMs = clampMs(
    tickerOpt.timeoutMs === undefined
      ? tickerEnv[LIVE_TICKER_TIMEOUT_ENV]
      : String(tickerOpt.timeoutMs),
    LIVE_TICKER_DEFAULT_TIMEOUT_MS,
    LIVE_TICKER_MIN_TIMEOUT_MS,
    LIVE_TICKER_MAX_TIMEOUT_MS,
  );

  const pendingTimeoutMs = clampMs(
    pendingOpt.timeoutMs === undefined
      ? pendingEnv[LIVE_PENDING_TIMEOUT_ENV]
      : String(pendingOpt.timeoutMs),
    LIVE_PENDING_DEFAULT_TIMEOUT_MS,
    LIVE_PENDING_MIN_TIMEOUT_MS,
    LIVE_PENDING_MAX_TIMEOUT_MS,
  );

  const pendingMaxCustomers = clampMs(
    pendingOpt.maxCustomers === undefined
      ? pendingEnv[LIVE_PENDING_MAX_CUSTOMERS_ENV]
      : String(pendingOpt.maxCustomers),
    LIVE_PENDING_DEFAULT_MAX_CUSTOMERS,
    1,
    LIVE_PENDING_MAX_MAX_CUSTOMERS,
  );

  const persistExplicit = pendingOpt.persistence?.enabled;
  const persistGateOn =
    persistExplicit === true ||
    (persistExplicit !== false &&
      (envFlag(pendingEnv, LIVE_PERSIST_GATE) ??
        pendingEnv.NODE_ENV !== "test"));

  const persistThrottleMs = clampMs(
    pendingOpt.persistence?.throttleMs === undefined
      ? pendingEnv[LIVE_PERSIST_MS_ENV]
      : String(pendingOpt.persistence?.throttleMs),
    LIVE_PERSIST_DEFAULT_THROTTLE_MS,
    0,
    600_000,
  );

  const persistRootExplicit =
    pendingOpt.persistence?.rootDir ?? pendingEnv[LIVE_PERSIST_ROOT_ENV];
  const injectedFetch =
    tickerOpt.fetch !== undefined || pendingOpt.fetch !== undefined;
  const persistRoot = resolve(
    persistRootExplicit ??
      (injectedFetch
        ? mkdtempSync(join(tmpdir(), "sportsdesk-live-persist-"))
        : options.repoRoot),
  );
  const persistRootKind: "repo" | "custom" =
    resolve(persistRoot) === resolve(options.repoRoot) ? "repo" : "custom";

  let tickerRowsForScope: readonly Record<string, unknown>[] = [];
  let persistTickerState: LivePersistState | null = null;
  let persistPendingState: LivePersistState | null = null;

  type FeedCacheSnapshot<Entry> =
    | { readonly kind: "cold" }
    | {
        readonly kind: "fetching";
        readonly flight: Promise<Entry>;
        readonly previous: {
          readonly entry: Entry;
          readonly atMs: number;
        } | null;
      }
    | {
        readonly kind: "fresh";
        readonly entry: Entry;
        readonly atMs: number;
      }
    | {
        readonly kind: "degraded";
        readonly entry: Entry;
        readonly atMs: number;
      };

  const tickerCacheMachine = createStateMachine<
    FeedCacheSnapshot<TickerCacheEntry>
  >({
    graph: LIVE_FEED_CACHE_GRAPH,
    initial: { kind: "cold" },
  });
  const pendingCacheMachine = createStateMachine<
    FeedCacheSnapshot<PendingCacheEntry>
  >({
    graph: LIVE_FEED_CACHE_GRAPH,
    initial: { kind: "cold" },
  });

  function latestFeedStatus<Entry extends { readonly status: unknown }>(
    snap: FeedCacheSnapshot<Entry>,
  ): Entry["status"] | null {
    switch (snap.kind) {
      case "cold":
        return null;
      case "fetching":
        return snap.previous?.entry.status ?? null;
      case "fresh":
      case "degraded":
        return snap.entry.status;
    }
  }

  function cachedFeedRecord<Entry>(
    snap: FeedCacheSnapshot<Entry>,
  ): { readonly entry: Entry; readonly atMs: number } | null {
    switch (snap.kind) {
      case "cold":
        return null;
      case "fetching":
        return snap.previous;
      case "fresh":
      case "degraded":
        return { entry: snap.entry, atMs: snap.atMs };
    }
  }

  const refreshEnv: Readonly<Record<string, string | undefined>> = {
    ...Bun.env,
    ...tickerEnv,
    ...pendingEnv,
  };

  function readRefreshEnvMs(
    env: Readonly<Record<string, string | undefined>>,
  ): number | null {
    const raw = env[LIVE_REFRESH_ENV];
    if (raw === undefined || raw.trim() === "") return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(LIVE_REFRESH_MAX_MS, Math.max(0, Math.trunc(parsed)));
  }

  const envRefreshMs = readRefreshEnvMs(refreshEnv);
  const statusRefreshIntervalMs =
    options.liveRefresh?.intervalMs ?? envRefreshMs ?? LIVE_REFRESH_DEFAULT_MS;

  function refreshEnabled(): boolean {
    if (options.liveRefresh?.enabled === false) return false;
    if (options.liveRefresh?.enabled === true) {
      if (options.liveRefresh.intervalMs !== undefined) return true;
      return statusRefreshIntervalMs > 0;
    }
    if (options.daemonEntry === true) {
      return statusRefreshIntervalMs > 0;
    }
    return false;
  }

  function loopIntervalMs(): number {
    if (options.liveRefresh?.intervalMs !== undefined) {
      return options.liveRefresh.intervalMs;
    }
    if (envRefreshMs !== null) {
      return envRefreshMs > 0 ? envRefreshMs : LIVE_REFRESH_DEFAULT_MS;
    }
    return LIVE_REFRESH_DEFAULT_MS;
  }

  const refreshIntervalMs = loopIntervalMs();

  interface RefreshStats {
    readonly ticks: number;
    readonly lastAt: string | null;
    readonly lastOk: boolean | null;
    readonly lastError: string | null;
  }

  type RefreshLoopSnapshot =
    | { readonly kind: "disabled"; readonly stats: RefreshStats }
    | {
        readonly kind: "idle";
        readonly timer: ReturnType<typeof setInterval>;
        readonly stats: RefreshStats;
      }
    | {
        readonly kind: "in_flight";
        readonly timer: ReturnType<typeof setInterval>;
        readonly stats: RefreshStats;
      }
    | { readonly kind: "stopped"; readonly stats: RefreshStats };

  const initialStats: RefreshStats = {
    ticks: 0,
    lastAt: null,
    lastOk: null,
    lastError: null,
  };
  const refreshMachine = createStateMachine<RefreshLoopSnapshot>({
    graph: LIVE_REFRESH_LOOP_GRAPH,
    initial: { kind: "disabled", stats: initialStats },
  });

  function cacheFresh(at: number, ttlMs: number, nowMs: number): boolean {
    return ttlMs > 0 && nowMs - at < ttlMs;
  }

  function tickerStatusFromFetch(
    mode: LiveSourceMode,
    servedFromCache: boolean,
    result: Awaited<ReturnType<typeof fetchLiveBetTicker>>,
  ): LiveTickerStatusBody {
    if (!tickerGateOn) {
      return disabledTickerStatus(mode, tickerTtlMs);
    }
    return {
      mode,
      status: result.ok ? "live" : "unavailable",
      ok: result.ok,
      fetchedAt: result.observedAt,
      servedFromCache,
      transport: result.transport,
      diagnostic: toDiagnostic(result.diagnostic),
      ttlMs: tickerTtlMs,
    };
  }

  function pendingStatusFromFetch(
    mode: LiveSourceMode,
    servedFromCache: boolean,
    result: Awaited<ReturnType<typeof fetchLivePending>>,
    scopeSource: LivePendingScopeSource,
  ): LivePendingStatusBody {
    if (!pendingGateOn) {
      return disabledPendingStatus(mode, pendingTtlMs);
    }
    return {
      mode,
      status: result.ok ? "live" : "unavailable",
      ok: result.ok,
      fetchedAt: result.observedAt,
      servedFromCache,
      transport: result.transport,
      diagnostic: toDiagnostic(result.diagnostic),
      scopeSource,
      customersAttempted: result.customersAttempted,
      customersFailed: result.customersFailed,
      ttlMs: pendingTtlMs,
    };
  }

  async function persistTicker(
    payload: unknown,
    observedAt: string,
    transport: string | null,
    rowCount: number,
    servedFromCache: boolean,
  ): Promise<void> {
    if (!persistGateOn || servedFromCache) return;
    const file = liveTickerFile(payload, observedAt);
    const artifactText = `${JSON.stringify(file)}\n`;
    try {
      const outcome = await persistLiveSnapshot({
        rootDir: persistRoot,
        throttleMs: persistThrottleMs,
        now: tickerNow(),
        previous: persistTickerState,
        snapshot: {
          source: "getBetTicker",
          operation: BET_TICKER_OPERATION,
          artifactPath: "data/live-wagers.json",
          artifactText,
          observedAt,
          transport,
          httpStatus: 200,
          rows: rowCount,
          partial: false,
        },
      });
      persistTickerState = outcome.state;
    } catch {
      // Persistence failure never fails the HTTP response.
    }
  }

  async function persistPending(
    artifact: LiveBetsArtifact,
    transport: string | null,
    servedFromCache: boolean,
  ): Promise<void> {
    if (!persistGateOn || servedFromCache) return;
    const artifactText = `${JSON.stringify(artifact)}\n`;
    try {
      const outcome = await persistLiveSnapshot({
        rootDir: persistRoot,
        throttleMs: persistThrottleMs,
        now: pendingNow(),
        previous: persistPendingState,
        snapshot: {
          source: "Pending",
          operation: REPORT_PENDING_OPERATION,
          artifactPath: "data/live-bets.json",
          artifactText,
          observedAt: artifact.capturedAt ?? pendingNow().toISOString(),
          transport,
          httpStatus: 200,
          rows: artifact.pendingCount,
          partial: false,
        },
      });
      persistPendingState = outcome.state;
    } catch {
      // Persistence failure never fails the HTTP response.
    }
  }

  async function readTickerLive(
    mode: LiveSourceMode,
    force: boolean,
  ): Promise<TickerCacheEntry> {
    // Explicit `file` mode or disabled gate never poisons the live cache state machine.
    if (!tickerGateOn || mode === "file") {
      return {
        status: disabledTickerStatus(mode, tickerTtlMs),
        artifact: null,
        rawPayload: null,
      };
    }

    const nowMs = tickerNow().getTime();
    const snap = tickerCacheMachine.state;
    const existing = cachedFeedRecord(snap);
    if (
      !force &&
      existing !== null &&
      cacheFresh(existing.atMs, tickerTtlMs, nowMs)
    ) {
      return {
        ...existing.entry,
        status: { ...existing.entry.status, mode, servedFromCache: true },
      };
    }

    if (!force && snap.kind === "fetching") {
      const joined = await snap.flight;
      return {
        ...joined,
        status: { ...joined.status, mode },
      };
    }

    let flight!: Promise<TickerCacheEntry>;
    flight = (async (): Promise<TickerCacheEntry> => {
      const startedMs = tickerNow().getTime();
      const result = await fetchLiveBetTicker({
        ...(tickerOpt.fetch === undefined
          ? {}
          : { fetchImpl: tickerOpt.fetch }),
        ...(tickerOpt.session === undefined
          ? {}
          : { session: tickerOpt.session }),
        ...(tickerOpt.agentId === undefined
          ? {}
          : { agentId: tickerOpt.agentId }),
        timeoutMs: tickerTimeoutMs,
        now: tickerNow(),
        env: tickerEnv,
      });

      const status = tickerStatusFromFetch(mode, false, result);
      let artifact: WagerListArtifact | null = null;
      let rawPayload: unknown = null;

      if (result.ok) {
        rawPayload = { LIST: result.rows };
        tickerRowsForScope = result.rows;
        artifact = readWagerListArtifact(
          liveTickerFile(rawPayload, result.observedAt),
        );
        await persistTicker(
          rawPayload,
          result.observedAt,
          result.transport,
          result.rows.length,
          false,
        );
      }

      const entry: TickerCacheEntry = { status, artifact, rawPayload };
      if (
        tickerCacheMachine.state.kind === "fetching" &&
        tickerCacheMachine.state.flight === flight
      ) {
        tickerCacheMachine.transition(
          {
            kind: result.ok ? "fresh" : "degraded",
            entry,
            atMs: startedMs,
          },
          result.ok ? "ticker_ok" : "ticker_failed",
        );
      }
      return entry;
    })();

    tickerCacheMachine.transition(
      { kind: "fetching", flight, previous: existing },
      "ticker_fetch",
    );
    return flight;
  }

  async function resolvePendingCustomers(): Promise<{
    readonly customers: string[];
    readonly source: LivePendingScopeSource;
  }> {
    const explicit = parseCustomers(pendingEnv, pendingOpt.customers);
    if (explicit.length > 0) {
      return { customers: explicit, source: "env" };
    }
    const ticker = pendingCustomersFromTickerRows(
      tickerRowsForScope,
      pendingMaxCustomers,
    );
    return {
      customers: ticker,
      source: ticker.length > 0 ? "ticker" : "none",
    };
  }

  async function readPendingLive(
    mode: LiveSourceMode,
    force: boolean,
  ): Promise<PendingCacheEntry> {
    // Explicit `file` mode or disabled gate never poisons the live cache state machine.
    if (!pendingGateOn || mode === "file") {
      return {
        status: disabledPendingStatus(mode, pendingTtlMs),
        artifact: null,
      };
    }

    const nowMs = pendingNow().getTime();
    const snap = pendingCacheMachine.state;
    const existing = cachedFeedRecord(snap);
    if (
      !force &&
      existing !== null &&
      cacheFresh(existing.atMs, pendingTtlMs, nowMs)
    ) {
      return {
        ...existing.entry,
        status: { ...existing.entry.status, mode, servedFromCache: true },
      };
    }

    if (!force && snap.kind === "fetching") {
      const joined = await snap.flight;
      return {
        ...joined,
        status: { ...joined.status, mode },
      };
    }

    let flight!: Promise<PendingCacheEntry>;
    flight = (async (): Promise<PendingCacheEntry> => {
      if (
        pendingOpt.customers === undefined &&
        parseCustomers(pendingEnv).length === 0 &&
        tickerGateOn &&
        tickerRowsForScope.length === 0
      ) {
        await readTickerLive("auto", false);
      }

      const startedMs = pendingNow().getTime();
      const scope = await resolvePendingCustomers();
      const result = await fetchLivePending({
        customers: scope.customers,
        ...(pendingOpt.fetch === undefined
          ? {}
          : { fetchImpl: pendingOpt.fetch }),
        ...(pendingOpt.session === undefined
          ? {}
          : { session: pendingOpt.session }),
        maxCustomers: pendingMaxCustomers,
        timeoutMs: pendingTimeoutMs,
        now: pendingNow(),
        env: pendingEnv,
      });

      const status = pendingStatusFromFetch(mode, false, result, scope.source);
      let artifact: LiveBetsArtifact | null = null;
      if (result.ok) {
        artifact = livePendingArtifact(result.rows, {
          operation: REPORT_PENDING_OPERATION,
          capturedAt: result.observedAt,
        });
        await persistPending(artifact, result.transport, false);
      }

      const entry: PendingCacheEntry = { status, artifact };
      if (
        pendingCacheMachine.state.kind === "fetching" &&
        pendingCacheMachine.state.flight === flight
      ) {
        pendingCacheMachine.transition(
          {
            kind: result.ok ? "fresh" : "degraded",
            entry,
            atMs: startedMs,
          },
          result.ok ? "pending_ok" : "pending_failed",
        );
      }
      return entry;
    })();

    pendingCacheMachine.transition(
      { kind: "fetching", flight, previous: existing },
      "pending_fetch",
    );
    return flight;
  }

  async function loadFileWagers(): Promise<{
    chosen: {
      readonly path: string;
      readonly artifact: WagerListArtifact;
      readonly mtime: Date;
    } | null;
    skipped: ReadonlyArray<{ path: string; reason: string }>;
  }> {
    if (options.loadWagerList === undefined) {
      return { chosen: null, skipped: [] };
    }
    return options.loadWagerList();
  }

  async function refreshTick(): Promise<void> {
    if (!tickerGateOn && !pendingGateOn) return;
    const snap = refreshMachine.state;
    // Skip overlapping ticks (`in_flight`) and refuse to run when `disabled` or `stopped`.
    if (snap.kind !== "idle") return;

    const tickStartedIso = pendingNow().toISOString();
    const nextTicks = snap.stats.ticks + 1;
    refreshMachine.transition(
      {
        kind: "in_flight",
        timer: snap.timer,
        stats: {
          ticks: nextTicks,
          lastAt: tickStartedIso,
          lastOk: snap.stats.lastOk,
          lastError: null,
        },
      },
      "tick_start",
    );
    const tickGen = refreshMachine.generation;

    let lastOk = false;
    let lastError: string | null = null;
    try {
      const ticker = await readTickerLive("auto", true);
      if (!refreshMachine.isCurrent(tickGen)) return;
      const pending = await readPendingLive("auto", true);
      if (!refreshMachine.isCurrent(tickGen)) return;
      lastOk = ticker.status.ok && pending.status.ok;
      if (!lastOk) {
        const parts: string[] = [];
        if (!ticker.status.ok && ticker.status.diagnostic?.code) {
          parts.push(ticker.status.diagnostic.code);
        }
        if (!pending.status.ok && pending.status.diagnostic?.code) {
          parts.push(pending.status.diagnostic.code);
        }
        lastError = parts.join("; ") || "live read failed";
      }
    } catch (error) {
      lastOk = false;
      lastError = error instanceof Error ? error.message : String(error);
    }

    const after = refreshMachine.state;
    if (refreshMachine.isCurrent(tickGen) && after.kind === "in_flight") {
      refreshMachine.transition(
        {
          kind: "idle",
          timer: after.timer,
          stats: {
            ticks: nextTicks,
            lastAt: tickStartedIso,
            lastOk,
            lastError,
          },
        },
        "tick_settled",
      );
    }
  }

  function startRefreshLoop(): (() => void) | null {
    const snap = refreshMachine.state;
    if (
      !refreshEnabled() ||
      (snap.kind !== "disabled" && snap.kind !== "stopped")
    ) {
      return null;
    }
    const jitter =
      options.liveRefresh?.jitterMs === undefined
        ? 0
        : Math.max(0, options.liveRefresh.jitterMs);
    const intervalMs = Math.max(1, refreshIntervalMs + jitter);
    const timer = setInterval(() => {
      void refreshTick();
    }, intervalMs);
    refreshMachine.transition(
      { kind: "idle", timer, stats: snap.stats },
      "loop_start",
    );
    const stop = (): void => {
      const current = refreshMachine.state;
      if (current.kind === "idle" || current.kind === "in_flight") {
        clearInterval(current.timer);
        refreshMachine.transition(
          { kind: "stopped", stats: current.stats },
          "loop_stop",
        );
      }
    };
    options.liveRefresh?.onStarted?.(stop);
    return stop;
  }

  function statusBlock(options?: { exposeReads?: boolean }): LiveStatusBlock {
    const stats = refreshMachine.state.stats;
    const expose =
      options?.exposeReads === true || (refreshEnabled() && stats.ticks > 0);
    const tickerStatus = expose
      ? (latestFeedStatus(tickerCacheMachine.state) ??
        (!tickerGateOn ? disabledTickerStatus("auto", tickerTtlMs) : null))
      : null;
    const pendingStatus = expose
      ? (latestFeedStatus(pendingCacheMachine.state) ??
        (!pendingGateOn ? disabledPendingStatus("auto", pendingTtlMs) : null))
      : null;
    return {
      ticker: tickerStatus,
      pending: pendingStatus,
      refresh: {
        enabled: refreshEnabled(),
        intervalMs: statusRefreshIntervalMs,
        ticks: stats.ticks,
        lastTickAt: stats.lastAt,
        lastTickOk: stats.lastOk,
        lastError: stats.lastError,
      },
      persistence: {
        enabled: persistGateOn,
        artifactRoot: persistRootKind,
        throttleMs: persistThrottleMs,
      },
    };
  }

  return {
    tickerGateOn,
    pendingGateOn,
    persistGateOn,
    startRefreshLoop,
    statusBlock,

    async readLivePendingArtifact(): Promise<LiveBetsArtifact | null> {
      const live = await readPendingLive("live", false);
      return live.status.status === "live" ? live.artifact : null;
    },

    async serveLiveBets(mode: LiveSourceMode): Promise<LiveBetsServeResult> {
      const now = pendingNow();
      const live = await readPendingLive(mode, false);

      const useLive = live.status.status === "live" && live.artifact !== null;
      if (mode === "live" && !useLive) {
        return {
          httpStatus: 503,
          body: {
            success: false,
            error: "live Report/Pending unavailable",
            live: live.status,
          },
        };
      }

      const resolved =
        useLive && mode !== "file"
          ? await resolveLiveBets(
              { source: "db", fallback: "strict" },
              {
                repoRoot: options.repoRoot,
                readDb: async () => live.artifact,
                now: () => now,
                scoreboard: null,
              },
            )
          : await resolveLiveBets(
              {
                source: "file",
                fallback: "strict",
                path: options.liveBetsPath,
              },
              {
                repoRoot: options.repoRoot,
                defaultFilePath: options.liveBetsPath,
                now: () => now,
                scoreboard: null,
              },
            );

      const { summary } = resolved;
      const fresh = freshness(
        summary.capturedAt,
        now,
        STALE_AFTER_SECONDS.liveBets,
        now,
      );

      const liveStatus =
        mode === "file"
          ? disabledPendingStatus("file", pendingTtlMs)
          : { ...live.status, mode };

      return {
        httpStatus: 200,
        etagParts: `${summary.dataSource}|${summary.capturedAt}|${JSON.stringify(liveStatus)}`,
        body: {
          success: true,
          games: resolved.games,
          agents: resolved.agents,
          pendingCount: summary.totalPending,
          summary,
          freshness: fresh,
          live: liveStatus,
          generatedAt: now.toISOString(),
        },
      };
    },

    async serveLiveBetsSummary(
      mode: LiveSourceMode,
    ): Promise<LiveBetsServeResult> {
      const full = await this.serveLiveBets(mode);
      if (full.httpStatus !== 200) return full;
      const body = full.body;
      const summary = body.summary as LiveBetsSummary;
      const etagParts = `${full.etagParts}|${summary.totalGames}|${summary.totalWagered}|${summary.totalToWin}|${summary.totalPending}`;
      return {
        httpStatus: 200,
        etagParts,
        body: {
          success: true,
          summary,
          generatedAt: body.generatedAt,
          freshness: body.freshness,
          live: body.live,
        },
      };
    },

    async serveLiveWagers(
      mode: LiveSourceMode,
      fileSelection: Awaited<ReturnType<typeof loadFileWagers>>,
    ): Promise<LiveWagersServeResult> {
      const now = tickerNow();
      const live = await readTickerLive(mode, false);
      const skipped = [...fileSelection.skipped];

      if (mode === "file") {
        const chosen = fileSelection.chosen;
        if (chosen === null) {
          return {
            httpStatus: 404,
            body: {
              error: "no live wager list",
              hint: "run bun run capture:bet-ticker (writes data/bet-ticker.json), or save a ticker paste as data/live-wagers.json, and reload",
              skipped,
              live: disabledTickerStatus("file", tickerTtlMs),
            },
          };
        }
        return {
          httpStatus: 200,
          body: {
            success: true,
            servedFrom: "file",
            provenance: chosen.artifact.provenance,
            freshness: freshness(
              chosen.artifact.provenance.observedAt,
              chosen.mtime,
              STALE_AFTER_SECONDS.liveWagers,
              now,
            ),
            skipped,
            wagers: chosen.artifact.wagers,
            live: disabledTickerStatus("file", tickerTtlMs),
          },
        };
      }

      const liveArtifact = live.artifact;
      const liveOk = live.status.status === "live" && liveArtifact !== null;

      if (mode === "live" && !liveOk) {
        return {
          httpStatus: 503,
          body: {
            success: false,
            error: "live getBetTicker unavailable",
            live: live.status,
          },
        };
      }

      if (liveOk) {
        skipped.push(...fileSelection.skipped);
        if (fileSelection.chosen !== null) {
          skipped.push({
            path: fileSelection.chosen.path,
            reason: "older than live:getBetTicker",
          });
        }
        const artifact = liveArtifact!;
        const { ageSeconds: _age, ...fresh } = freshness(
          artifact.provenance.observedAt,
          now,
          STALE_AFTER_SECONDS.liveWagers,
          now,
        );
        return {
          httpStatus: 200,
          body: {
            success: true,
            servedFrom: "live",
            provenance: artifact.provenance,
            freshness: fresh,
            skipped,
            wagers: artifact.wagers,
            live: live.status,
          },
        };
      }

      const chosen = fileSelection.chosen;
      if (chosen === null) {
        return {
          httpStatus: 404,
          body: {
            error: "no live wager list",
            hint: "Set F402_AGENT_ID or the f402-agent-id keychain entry, run bun run session:login, run bun run capture:bet-ticker (writes data/bet-ticker.json), or save a ticker paste as data/live-wagers.json, and reload",
            skipped,
            live: live.status,
          },
        };
      }

      const { ageSeconds: _age, ...fresh } = freshness(
        chosen.artifact.provenance.observedAt,
        chosen.mtime,
        STALE_AFTER_SECONDS.liveWagers,
        now,
      );
      return {
        httpStatus: 200,
        body: {
          success: true,
          servedFrom: "file",
          provenance: chosen.artifact.provenance,
          freshness: fresh,
          skipped,
          wagers: chosen.artifact.wagers,
          live: live.status,
        },
      };
    },

    async kpiLiveInputs(): Promise<{
      live: LiveTickerStatusBody;
      livePending: LivePendingStatusBody;
      liveBets: KpiInput<LiveBetsArtifact> | null;
      liveWagers: KpiInput<WagerListArtifact> | null;
    }> {
      const now = pendingNow();
      const [ticker, pending, fileBets, fileWagers] = await Promise.all([
        readTickerLive("auto", false),
        readPendingLive("auto", false),
        resolveLiveBets(
          { source: "file", fallback: "strict", path: options.liveBetsPath },
          {
            repoRoot: options.repoRoot,
            defaultFilePath: options.liveBetsPath,
            now: () => now,
            scoreboard: null,
          },
        ),
        loadFileWagers(),
      ]);

      const liveBets: KpiInput<LiveBetsArtifact> | null =
        pending.artifact !== null && pending.status.ok
          ? { value: pending.artifact, mtime: now }
          : fileBets.dataSource !== "none" &&
              fileBets.summary.dataSource !== "none"
            ? {
                value: {
                  schemaVersion: 1,
                  dataSource: fileBets.summary.dataSource,
                  capturedAt: fileBets.summary.capturedAt,
                  operation: REPORT_PENDING_OPERATION,
                  pendingCount: fileBets.pendingCount,
                  agents: fileBets.agents,
                  games: fileBets.games,
                },
                mtime: now,
              }
            : null;

      const liveWagers: KpiInput<WagerListArtifact> | null =
        ticker.artifact !== null && ticker.status.ok
          ? { value: ticker.artifact, mtime: now }
          : fileWagers.chosen === null
            ? null
            : {
                value: fileWagers.chosen.artifact,
                mtime: fileWagers.chosen.mtime,
              };

      return {
        live: ticker.status,
        livePending: pending.status,
        liveBets,
        liveWagers,
      };
    },
  };
}

export type DeskLiveReads = ReturnType<typeof createDeskLiveReads>;
