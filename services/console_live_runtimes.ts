/**
 * @file services/console_live_runtimes.ts
 * @description Env-gated producers for the two live console channels.
 *
 * Both are off by default so a test or a CLI import never starts a timer or reads a
 * production artifact by accident:
 *
 *  - `SPORTSDESK_WAGER_TELEMETRY=on` polls `data/live-wagers.json` and publishes one
 *    32-byte tick per mapped wager to the subscribed bridge sockets.
 *  - `SPORTSDESK_THRESHOLD_ALERTS=on` evaluates the threshold engine on an interval and
 *    dispatches a Telegram message on a new breach.
 *
 * The alert collector measures only the bridge-relay lag. Downline exposure, partner
 * liquidity and churn lift have no producer yet, so they are reported as `unmeasured`
 * and cannot fire or clear a bit. The policy boundaries for those three are set so a
 * later measured value cannot silently inherit a triggering threshold.
 */

import { resolve } from "node:path";

import {
  asBasisPoints,
  asCents,
  asDurationMilliseconds,
} from "../lib/bridge_and_channel_router.ts";
import { liveWagerRows } from "../lib/customer_source_rows.ts";
import {
  createTelegramThresholdSender,
  type MeasuredDeskSnapshot,
  type ThresholdPolicy,
} from "../lib/threshold_alert_engine.ts";
import {
  createJsonThresholdStateStore,
  createThresholdAlertLoop,
  type ThresholdAlertLoop,
} from "../lib/threshold_alert_runtime.ts";
import {
  createWagerTickProducer,
  type LiveWagerRow,
  type WagerTickProducer,
} from "../lib/wager_tick_producer.ts";
import type { WagerTickInput } from "../lib/wager_telemetry_hub.ts";

const WAGER_POLL_INTERVAL_MS = 5_000;
const ALERT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_WAGER_INTERVAL_MS = 60_000;
const MAX_ALERT_INTERVAL_MS = 3_600_000;
const DEFAULT_BRIDGE_LAG_SLA_MS = 45_000;

export interface ConsoleLiveRuntimeOptions {
  readonly cwd: string;
  readonly publishTick: (tick: WagerTickInput) => unknown;
  /** Age of the last bridge-relay frame, or null when no frame has arrived. */
  readonly bridgeLagMs: () => number | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  /** Test seam; defaults to `data/live-wagers.json` under `cwd`. */
  readonly readLiveWagerRows?:
    (() => Promise<readonly Record<string, unknown>[]>) | undefined;
}

export interface ConsoleLiveRuntimeStatus {
  readonly started: readonly string[];
  readonly skipped: readonly string[];
  /** Present only when the wager poller is running. */
  readonly wagerTelemetry: {
    readonly intervalMs: number;
    readonly lastPollAtEpochMs: number | null;
  } | null;
  /** Present only when the threshold alert loop is running. */
  readonly thresholdAlerts: { readonly intervalMs: number } | null;
}

export interface ConsoleLiveRuntimes {
  readonly started: readonly string[];
  readonly skipped: readonly string[];
  /** Stops both loops; idempotent, and a late poll result is not published. */
  stop(): void;
  /** Serializable operator view of which channels are running and when they last ran. */
  statusBlock(): ConsoleLiveRuntimeStatus;
}

function enabled(value: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test(value?.trim() ?? "");
}

function intervalFrom(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Named fields only: the wire row is external JSON and every value is validated later. */
function toLiveWagerRow(row: Record<string, unknown>): LiveWagerRow {
  return {
    WagerNumber: row.WagerNumber,
    TicketWriter: row.TicketWriter,
    AmountWagered: row.AmountWagered,
    InsertDateTime: row.InsertDateTime,
    ShortDesc: row.ShortDesc,
  };
}

async function readLiveWagerFile(
  cwd: string,
): Promise<readonly Record<string, unknown>[]> {
  const path = resolve(cwd, "data/live-wagers.json");
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return liveWagerRows(await file.json());
}

function startWagerTelemetry(
  options: ConsoleLiveRuntimeOptions,
  env: Readonly<Record<string, string | undefined>>,
  isStopped: () => boolean,
  started: string[],
): {
  readonly producer: WagerTickProducer;
  readonly intervalMs: number;
  readonly stop: () => void;
} {
  const intervalMs = intervalFrom(
    env.SPORTSDESK_WAGER_TELEMETRY_INTERVAL_MS,
    WAGER_POLL_INTERVAL_MS,
    MIN_INTERVAL_MS,
    MAX_WAGER_INTERVAL_MS,
  );
  const readInjectedRows = options.readLiveWagerRows;
  const readRows = async (): Promise<readonly LiveWagerRow[]> => {
    const rows = await (readInjectedRows === undefined
      ? readLiveWagerFile(options.cwd)
      : readInjectedRows());
    return rows.map(toLiveWagerRow);
  };
  const producerOptions = {
    readRows,
    publish: (tick: WagerTickInput): unknown => {
      if (isStopped()) return undefined;
      return options.publishTick(tick);
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const producer = createWagerTickProducer(producerOptions);

  const poll = (): void => {
    if (isStopped()) return;
    void producer.pollOnce().catch((error: unknown) => {
      console.warn(
        `[console-live] wager telemetry poll failed: ${errorMessage(error)}`,
      );
    });
  };

  const timer = setInterval(poll, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  started.push("wager-telemetry");
  poll();
  return {
    producer,
    intervalMs,
    stop: () => clearInterval(timer),
  };
}

function startThresholdAlerts(
  options: ConsoleLiveRuntimeOptions,
  env: Readonly<Record<string, string | undefined>>,
  started: string[],
  skipped: string[],
): { readonly loop: ThresholdAlertLoop; readonly intervalMs: number } | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = env.TELEGRAM_CHAT_ID?.trim() ?? "";
  if (botToken === "" || chatId === "") {
    skipped.push("threshold-alerts:telegram_not_configured");
    return null;
  }

  const policy: ThresholdPolicy = {
    // Unmeasured today. These boundaries keep a future collector from inheriting a
    // triggering threshold it never agreed to.
    maxDownlineExposureCents: asCents(Number.MAX_SAFE_INTEGER),
    minPartnerLiquidityRatioBps: asBasisPoints(0),
    maxChurnTopDecileLiftBps: asBasisPoints(Number.MAX_SAFE_INTEGER),
    maxBridgeLagMs: asDurationMilliseconds(
      intervalFrom(
        env.SPORTSDESK_BRIDGE_LAG_SLA_MS,
        DEFAULT_BRIDGE_LAG_SLA_MS,
        1_000,
        3_600_000,
      ),
    ),
  };
  const statePath =
    env.SPORTSDESK_THRESHOLD_STATE_PATH?.trim() ||
    resolve(options.cwd, "data/threshold-alert-state.json");

  const collect = async (): Promise<MeasuredDeskSnapshot> => {
    const lagMs = options.bridgeLagMs();
    return {
      downlineExposureCents: {
        kind: "unmeasured",
        reason: "downline exposure collector not wired",
      },
      partnerLiquidityRatioBps: {
        kind: "unmeasured",
        reason: "partner liquidity collector not wired",
      },
      churnTopDecileLiftBps: {
        kind: "unmeasured",
        reason: "churn lift collector not wired",
      },
      bridgeLagMs:
        lagMs === null
          ? {
              kind: "unmeasured",
              reason: "bridge relay has not delivered a frame",
            }
          : {
              kind: "measured",
              value: asDurationMilliseconds(Math.max(0, Math.round(lagMs))),
            },
    };
  };

  const intervalMs = intervalFrom(
    env.SPORTSDESK_THRESHOLD_INTERVAL_MS,
    ALERT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    MAX_ALERT_INTERVAL_MS,
  );
  const loop = createThresholdAlertLoop({
    intervalMs,
    collect,
    policy,
    store: createJsonThresholdStateStore(statePath),
    send: createTelegramThresholdSender({ botToken, chatId }),
    onError: (error: unknown) => {
      console.error(
        `[console-live] threshold alert tick failed: ${errorMessage(error)}`,
      );
    },
  });

  loop.start();
  void loop.tickOnce();
  started.push("threshold-alerts");
  return { loop, intervalMs };
}

export function startConsoleLiveRuntimes(
  options: ConsoleLiveRuntimeOptions,
): ConsoleLiveRuntimes {
  const env = options.env ?? Bun.env;
  const started: string[] = [];
  const skipped: string[] = [];
  const stops: Array<() => void> = [];
  let stopped = false;
  const isStopped = (): boolean => stopped;
  let wagerTelemetry: ReturnType<typeof startWagerTelemetry> | null = null;
  let thresholdAlerts: ReturnType<typeof startThresholdAlerts> = null;

  if (enabled(env.SPORTSDESK_WAGER_TELEMETRY)) {
    wagerTelemetry = startWagerTelemetry(options, env, isStopped, started);
    stops.push(wagerTelemetry.stop);
  } else {
    skipped.push("wager-telemetry:disabled");
  }

  if (enabled(env.SPORTSDESK_THRESHOLD_ALERTS)) {
    thresholdAlerts = startThresholdAlerts(options, env, started, skipped);
    if (thresholdAlerts !== null) stops.push(thresholdAlerts.loop.stop);
  } else {
    skipped.push("threshold-alerts:disabled");
  }

  return {
    started,
    skipped,
    statusBlock: () => ({
      started: [...started],
      skipped: [...skipped],
      wagerTelemetry:
        wagerTelemetry === null
          ? null
          : {
              intervalMs: wagerTelemetry.intervalMs,
              lastPollAtEpochMs: wagerTelemetry.producer.lastPollAtEpochMs,
            },
      thresholdAlerts:
        thresholdAlerts === null
          ? null
          : { intervalMs: thresholdAlerts.intervalMs },
    }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const stop of stops) stop();
    },
  };
}
