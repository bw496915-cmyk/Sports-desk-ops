/**
 * @file lib/threshold_alert_runtime.ts
 * @description Persisted-state driver for the partial-metric threshold alert engine.
 *
 * Three pieces:
 *
 * - `createJsonThresholdStateStore` owns the latched alert mask on disk. A write goes
 *   to a sibling temporary file and is renamed into place, so a crash leaves the
 *   previous complete JSON, never a half-written mask. A missing or corrupt file reads
 *   as the empty mask: fail open and alert again rather than silently suppressing a
 *   breach forever.
 * - `runThresholdEvaluation` composes evaluate -> dispatch -> commit. The widened mask
 *   is written only when `delivery.status === "sent"`, so a failed send keeps the
 *   previous mask and the same transition is retried on the next tick.
 * - `createThresholdAlertLoop` schedules those evaluations. A tick that overlaps an
 *   in-flight one resolves `busy` instead of sending twice; a throwing collector, store
 *   or sender is routed to `onError` and never becomes an unhandled rejection.
 *
 * The loop guards one process. Two processes sharing a state file can both send the
 * same transition: the store is atomic but it has no cross-process lock.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BitSet32 } from "../design/domain-branded-types.ts";
import { asBitSet32 } from "./bridge_and_channel_router.ts";
import {
  buildMeasuredDispatchMetrics,
  dispatchThresholdAlert,
  evaluateMeasuredAlerts,
  type MeasuredDeskSnapshot,
  type ThresholdAlertOutcome,
  type ThresholdAlertSender,
  type ThresholdPolicy,
} from "./threshold_alert_engine.ts";

const MASK32_MAX = 0xffff_ffff;

/* -------------------------------------------------------------------------- */
/* Persisted mask                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Where the committed mask lives between evaluations. `read` never rejects on a
 * missing/corrupt file (it answers the empty mask); `write` resolves only once the new
 * mask is in place atomically.
 */
export interface ThresholdStateStore {
  read(): Promise<BitSet32>;
  write(mask: BitSet32): Promise<void>;
}

/** Strict shape check: anything else is corrupt state, not a mask we may trust. */
function parsePersistedMask(parsed: unknown): BitSet32 | null {
  if (typeof parsed !== "object" || parsed === null || !("mask32" in parsed)) {
    return null;
  }
  const value: unknown = parsed.mask32;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > MASK32_MAX) return null;
  return asBitSet32(value);
}

/**
 * A store backed by a JSON file, written via a sibling temp file plus rename.
 *
 * The temp file is unique per write, so two concurrent writers race only on the
 * rename (last one wins); neither can leave the destination holding partial JSON.
 */
export function createJsonThresholdStateStore(
  path: string,
): ThresholdStateStore {
  return {
    async read(): Promise<BitSet32> {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        // Absent (normal first run) or unreadable: fail open to the empty mask.
        return asBitSet32(0);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return asBitSet32(0);
      }
      return parsePersistedMask(parsed) ?? asBitSet32(0);
    },

    async write(mask: BitSet32): Promise<void> {
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const payload = `${JSON.stringify({ mask32: asBitSet32(mask) }, null, 2)}\n`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporaryPath, payload, "utf8");
        await rename(temporaryPath, path);
      } catch (error) {
        // The destination was never touched; drop the sibling so a failed write
        // leaves no stray *.tmp behind, then let the caller see the failure.
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* One evaluated tick                                                         */
/* -------------------------------------------------------------------------- */

export type ThresholdEvaluationResult = ThresholdAlertOutcome & {
  readonly committedMask32: BitSet32;
  readonly unmeasured: readonly string[];
};

export interface RunThresholdEvaluationOptions {
  /**
   * Explicit previous mask. When omitted (or `undefined`) the store is read; an
   * explicit `asBitSet32(0)` is honored and the store is not read.
   */
  readonly prev?: BitSet32 | undefined;
  readonly readings: MeasuredDeskSnapshot;
  readonly policy: ThresholdPolicy;
  readonly store: ThresholdStateStore;
  readonly send: ThresholdAlertSender;
}

/**
 * Load the previous mask, evaluate the partial readings, dispatch only the newly
 * triggered transitions, and commit the widened mask after a successful send.
 *
 * If the store write fails, the error propagates and the mask is NOT advanced
 * (at-least-once delivery: the next tick offers the same transition again).
 */
export async function runThresholdEvaluation(
  options: RunThresholdEvaluationOptions,
): Promise<ThresholdEvaluationResult> {
  const prevAlertMask32 = options.prev ?? (await options.store.read());
  const evaluation = evaluateMeasuredAlerts(
    prevAlertMask32,
    options.readings,
    options.policy,
  );
  const delivery = await dispatchThresholdAlert(
    evaluation.newlyTriggeredMask32,
    buildMeasuredDispatchMetrics(
      evaluation.newlyTriggeredMask32,
      options.readings,
      options.policy,
    ),
    options.send,
  );
  const committedMask32 =
    delivery.status === "sent" ? evaluation.nextMask32 : prevAlertMask32;
  if (delivery.status === "sent") {
    await options.store.write(committedMask32);
  }
  return {
    nextMask32: evaluation.nextMask32,
    newlyTriggeredMask32: evaluation.newlyTriggeredMask32,
    delivery,
    committedMask32,
    unmeasured: evaluation.unmeasured,
  };
}

/* -------------------------------------------------------------------------- */
/* Scheduled loop                                                             */
/* -------------------------------------------------------------------------- */

export type ThresholdTickResult =
  | { readonly status: "busy" }
  | {
      readonly status: "completed";
      readonly result: ThresholdEvaluationResult;
    }
  | { readonly status: "failed"; readonly error: string };

export interface ThresholdAlertLoopOptions {
  readonly intervalMs: number;
  readonly collect: () => Promise<MeasuredDeskSnapshot>;
  readonly policy: ThresholdPolicy;
  readonly store: ThresholdStateStore;
  readonly send: ThresholdAlertSender;
  /** Error sink for a failed tick; defaults to `console.error`. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

export interface ThresholdAlertLoop {
  /** Start the interval; idempotent, and the timer is unref'd so a CLI can exit. */
  start(): void;
  /** Stop the interval; idempotent. An in-flight tick is allowed to finish. */
  stop(): void;
  /** Run one evaluation now. Never rejects: failures resolve as `failed`. */
  tickOnce(): Promise<ThresholdTickResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createThresholdAlertLoop(
  options: ThresholdAlertLoopOptions,
): ThresholdAlertLoop {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new RangeError(
      `createThresholdAlertLoop: intervalMs must be a positive finite number, received ${options.intervalMs}`,
    );
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<ThresholdTickResult> | null = null;

  const reportError = (error: unknown): void => {
    try {
      if (options.onError !== undefined) {
        options.onError(error);
      } else {
        console.error("[threshold_alert_loop] tick failed:", error);
      }
    } catch (sinkError) {
      // A throwing error sink must not turn a handled tick into an unhandled rejection.
      console.error("[threshold_alert_loop] onError threw:", sinkError);
    }
  };

  const executeTick = async (): Promise<ThresholdTickResult> => {
    try {
      const readings = await options.collect();
      const result = await runThresholdEvaluation({
        readings,
        policy: options.policy,
        store: options.store,
        send: options.send,
      });
      return { status: "completed", result };
    } catch (error) {
      reportError(error);
      return { status: "failed", error: errorMessage(error) };
    }
  };

  const tickOnce = async (): Promise<ThresholdTickResult> => {
    if (inFlight !== null) return { status: "busy" };
    const run = executeTick();
    inFlight = run;
    try {
      return await run;
    } finally {
      inFlight = null;
    }
  };

  const start = (): void => {
    if (timer !== null) return;
    const handle = setInterval(() => {
      // `tickOnce` reports its own failures; the catch is the last line of defence
      // against an error sink that itself throws.
      void tickOnce().catch((error: unknown) => reportError(error));
    }, options.intervalMs);
    (handle as unknown as { unref?: () => void }).unref?.();
    timer = handle;
  };

  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return { start, stop, tickOnce };
}
