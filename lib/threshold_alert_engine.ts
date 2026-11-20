/**
 * @file lib/threshold_alert_engine.ts
 * @description Monotonic threshold alerts for desk exposure, partner liquidity,
 * churn lift and bridge lag.
 *
 * The alert mask only grows: `next = prev | incoming`. A breach that recovers stays
 * latched until an operator clears it, so a flapping metric cannot produce a
 * shrink-then-retrigger alert storm. `newlyTriggered` is the transition set — the
 * bits that were not set before this evaluation and are the only ones dispatched.
 *
 * Dispatch advances the mask **only on success**. This is the part a naive
 * "evaluate, then send, then store next" pipeline gets wrong: if Telegram is down
 * while `next` is committed, `newlyTriggered` for that bit is empty forever and the
 * breach never reaches a human. `evaluateAndDispatchThresholdAlert` returns the
 * mask the caller may commit (`committedMask32`), which stays on `prev` after a
 * failed delivery so the next evaluation retries the same transition.
 *
 * `evaluateMeasuredAlerts` applies the same comparisons to a partially measured
 * `MeasuredDeskSnapshot`: an unmeasured reading can neither trigger nor clear a bit,
 * so one dead collector cannot silence or fabricate the other three metrics.
 *
 * No `fetch` here: the transport is injected. `createTelegramThresholdSender` is
 * the thin Bot API adapter for callers that want one.
 */

import type {
  BasisPoints,
  BitSet32,
  Cents,
  DurationMilliseconds,
} from "../design/domain-branded-types.ts";
import { asBitSet32 } from "./bridge_and_channel_router.ts";

export const ALERT_BIT = {
  DOWNLINE_EXPOSURE_BREACH: 1 << 0,
  PARTNER_LIQUIDITY_LOW: 1 << 1,
  CHURN_DECILE_SPIKE: 1 << 2,
  BRIDGE_LAG_SLA_BREACH: 1 << 3,
} as const;

export type AlertBit = (typeof ALERT_BIT)[keyof typeof ALERT_BIT];

export interface ThresholdPolicy {
  readonly maxDownlineExposureCents: Cents;
  readonly minPartnerLiquidityRatioBps: BasisPoints;
  readonly maxChurnTopDecileLiftBps: BasisPoints;
  readonly maxBridgeLagMs: DurationMilliseconds;
}

export interface DeskSnapshotMetrics {
  readonly downlineExposureCents: Cents;
  readonly partnerLiquidityRatioBps: BasisPoints;
  readonly churnTopDecileLiftBps: BasisPoints;
  readonly bridgeLagMs: DurationMilliseconds;
}

/**
 * A `measured` reading carries the number; an `unmeasured` one carries why the
 * collector could not produce it. A missing number is not a healthy number: an
 * unmeasured reading never sets an alert bit.
 */
export type MetricReading<T> =
  | { readonly kind: "measured"; readonly value: T }
  | { readonly kind: "unmeasured"; readonly reason: string };

/**
 * The snapshot the collectors may only partly fill: each metric is independently
 * measured or not, so one lost source does not suppress the other three.
 */
export interface MeasuredDeskSnapshot {
  readonly downlineExposureCents: MetricReading<Cents>;
  readonly partnerLiquidityRatioBps: MetricReading<BasisPoints>;
  readonly churnTopDecileLiftBps: MetricReading<BasisPoints>;
  readonly bridgeLagMs: MetricReading<DurationMilliseconds>;
}

export interface AlertEvaluation {
  readonly nextMask32: BitSet32;
  readonly newlyTriggeredMask32: BitSet32;
}

/**
 * Strict comparisons: a value exactly on the configured limit is inside policy.
 */
export function evaluateMonotonicAlerts(
  prevAlertMask32: BitSet32,
  metrics: DeskSnapshotMetrics,
  policy: ThresholdPolicy,
): AlertEvaluation {
  let incomingMask32 = 0;

  if (metrics.downlineExposureCents > policy.maxDownlineExposureCents) {
    incomingMask32 |= ALERT_BIT.DOWNLINE_EXPOSURE_BREACH;
  }
  if (metrics.partnerLiquidityRatioBps < policy.minPartnerLiquidityRatioBps) {
    incomingMask32 |= ALERT_BIT.PARTNER_LIQUIDITY_LOW;
  }
  if (metrics.churnTopDecileLiftBps > policy.maxChurnTopDecileLiftBps) {
    incomingMask32 |= ALERT_BIT.CHURN_DECILE_SPIKE;
  }
  if (metrics.bridgeLagMs > policy.maxBridgeLagMs) {
    incomingMask32 |= ALERT_BIT.BRIDGE_LAG_SLA_BREACH;
  }

  const nextMask32 = asBitSet32(prevAlertMask32 | incomingMask32);
  const newlyTriggeredMask32 = asBitSet32(nextMask32 & ~prevAlertMask32);
  return { nextMask32, newlyTriggeredMask32 };
}

/**
 * The policy boundary is the one value the strict comparison treats as inside policy,
 * so substituting it for an unmeasured reading keeps that reading from triggering.
 */
function readingValueOr<T>(reading: MetricReading<T>, policyBoundary: T): T {
  if (reading.kind === "measured") return reading.value;
  return policyBoundary;
}

/** Field names in `MeasuredDeskSnapshot` declaration order. */
function unmeasuredFieldNames(
  readings: MeasuredDeskSnapshot,
): readonly string[] {
  const unmeasured: string[] = [];
  if (readings.downlineExposureCents.kind === "unmeasured") {
    unmeasured.push("downlineExposureCents");
  }
  if (readings.partnerLiquidityRatioBps.kind === "unmeasured") {
    unmeasured.push("partnerLiquidityRatioBps");
  }
  if (readings.churnTopDecileLiftBps.kind === "unmeasured") {
    unmeasured.push("churnTopDecileLiftBps");
  }
  if (readings.bridgeLagMs.kind === "unmeasured") {
    unmeasured.push("bridgeLagMs");
  }
  return unmeasured;
}

/**
 * Evaluates a partially measured snapshot with the same strict comparisons as
 * `evaluateMonotonicAlerts`.
 *
 * Only measured readings can set a bit. An unmeasured reading is compared as its
 * policy boundary (inside policy), so it can neither trigger nor clear a bit — the
 * mask stays monotonic. `unmeasured` lists the field names the collector lost, so a
 * caller can surface partial coverage instead of treating it as a clean snapshot.
 */
export function evaluateMeasuredAlerts(
  prevAlertMask32: BitSet32,
  readings: MeasuredDeskSnapshot,
  policy: ThresholdPolicy,
): AlertEvaluation & { unmeasured: readonly string[] } {
  const comparableMetrics: DeskSnapshotMetrics = {
    downlineExposureCents: readingValueOr(
      readings.downlineExposureCents,
      policy.maxDownlineExposureCents,
    ),
    partnerLiquidityRatioBps: readingValueOr(
      readings.partnerLiquidityRatioBps,
      policy.minPartnerLiquidityRatioBps,
    ),
    churnTopDecileLiftBps: readingValueOr(
      readings.churnTopDecileLiftBps,
      policy.maxChurnTopDecileLiftBps,
    ),
    bridgeLagMs: readingValueOr(readings.bridgeLagMs, policy.maxBridgeLagMs),
  };
  return {
    ...evaluateMonotonicAlerts(prevAlertMask32, comparableMetrics, policy),
    unmeasured: unmeasuredFieldNames(readings),
  };
}

/** Human-readable lines for one dispatch; the first line is the heading. */
export function formatThresholdAlertLines(
  newlyTriggeredMask32: BitSet32,
  metrics: DeskSnapshotMetrics,
): readonly string[] {
  if (newlyTriggeredMask32 === 0) return [];

  const lines: string[] = ["[SportsDesk Ops] Threshold Breach"];
  if ((newlyTriggeredMask32 & ALERT_BIT.DOWNLINE_EXPOSURE_BREACH) !== 0) {
    lines.push(
      `• Downline Exposure: $${(metrics.downlineExposureCents / 100).toFixed(2)}`,
    );
  }
  if ((newlyTriggeredMask32 & ALERT_BIT.PARTNER_LIQUIDITY_LOW) !== 0) {
    lines.push(
      `• Partner Liquidity: ${(metrics.partnerLiquidityRatioBps / 100).toFixed(2)}%`,
    );
  }
  if ((newlyTriggeredMask32 & ALERT_BIT.CHURN_DECILE_SPIKE) !== 0) {
    lines.push(
      `• Churn Top-Decile Lift: ${(metrics.churnTopDecileLiftBps / 100).toFixed(2)}%`,
    );
  }
  if ((newlyTriggeredMask32 & ALERT_BIT.BRIDGE_LAG_SLA_BREACH) !== 0) {
    lines.push(`• Bridge SLA Lag: ${metrics.bridgeLagMs}ms`);
  }
  return lines;
}

function requireMeasured<T>(reading: MetricReading<T>, field: string): T {
  if (reading.kind === "measured") return reading.value;
  throw new Error(
    `threshold_alert_engine: cannot format unmeasured field ${field} (${reading.reason})`,
  );
}

/**
 * The full `DeskSnapshotMetrics` shape `dispatchThresholdAlert` formats, built from a
 * partial reading set.
 *
 * The formatter only reads the fields named by the mask it is given, and
 * `evaluateMeasuredAlerts` only sets a bit for a measured field, so a triggered bit's
 * field is always measured. A triggered bit over an unmeasured reading therefore means
 * the invariant broke; this throws instead of printing a number nobody measured.
 * Untriggered fields fall back to their policy boundary — unreachable by the formatter,
 * and, by construction, not a breach.
 */
export function buildMeasuredDispatchMetrics(
  newlyTriggeredMask32: BitSet32,
  readings: MeasuredDeskSnapshot,
  policy: ThresholdPolicy,
): DeskSnapshotMetrics {
  return {
    downlineExposureCents:
      (newlyTriggeredMask32 & ALERT_BIT.DOWNLINE_EXPOSURE_BREACH) !== 0
        ? requireMeasured(
            readings.downlineExposureCents,
            "downlineExposureCents",
          )
        : policy.maxDownlineExposureCents,
    partnerLiquidityRatioBps:
      (newlyTriggeredMask32 & ALERT_BIT.PARTNER_LIQUIDITY_LOW) !== 0
        ? requireMeasured(
            readings.partnerLiquidityRatioBps,
            "partnerLiquidityRatioBps",
          )
        : policy.minPartnerLiquidityRatioBps,
    churnTopDecileLiftBps:
      (newlyTriggeredMask32 & ALERT_BIT.CHURN_DECILE_SPIKE) !== 0
        ? requireMeasured(
            readings.churnTopDecileLiftBps,
            "churnTopDecileLiftBps",
          )
        : policy.maxChurnTopDecileLiftBps,
    bridgeLagMs:
      (newlyTriggeredMask32 & ALERT_BIT.BRIDGE_LAG_SLA_BREACH) !== 0
        ? requireMeasured(readings.bridgeLagMs, "bridgeLagMs")
        : policy.maxBridgeLagMs,
  };
}

export interface ThresholdAlertSenderResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
}

export type ThresholdAlertSender = (
  text: string,
) => Promise<ThresholdAlertSenderResult>;

export type ThresholdAlertDelivery =
  | { readonly status: "skipped" }
  | { readonly status: "sent" }
  | { readonly status: "failed"; readonly error: string };

export async function dispatchThresholdAlert(
  newlyTriggeredMask32: BitSet32,
  metrics: DeskSnapshotMetrics,
  send: ThresholdAlertSender,
): Promise<ThresholdAlertDelivery> {
  if (newlyTriggeredMask32 === 0) return { status: "skipped" };

  const text = formatThresholdAlertLines(newlyTriggeredMask32, metrics).join(
    "\n",
  );
  try {
    const result = await send(text);
    return result.ok
      ? { status: "sent" }
      : { status: "failed", error: result.error ?? "unknown_alert_error" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ThresholdAlertOutcome extends AlertEvaluation {
  readonly delivery: ThresholdAlertDelivery;
  /**
   * The mask to persist. Equal to `prevAlertMask32` when delivery failed, so the
   * same transition is offered again on the next evaluation.
   */
  readonly committedMask32: BitSet32;
}

export async function evaluateAndDispatchThresholdAlert(
  prevAlertMask32: BitSet32,
  metrics: DeskSnapshotMetrics,
  policy: ThresholdPolicy,
  send: ThresholdAlertSender,
): Promise<ThresholdAlertOutcome> {
  const evaluation = evaluateMonotonicAlerts(prevAlertMask32, metrics, policy);
  const delivery = await dispatchThresholdAlert(
    evaluation.newlyTriggeredMask32,
    metrics,
    send,
  );
  return {
    ...evaluation,
    delivery,
    committedMask32:
      delivery.status === "sent" ? evaluation.nextMask32 : prevAlertMask32,
  };
}

/**
 * Only the shape the adapter uses. `typeof fetch` is wider (it carries
 * `preconnect` on Bun 1.4.4), which makes a plain test double unassignable.
 */
export type ThresholdTelegramFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface TelegramThresholdSenderOptions {
  readonly botToken: string;
  readonly chatId: string;
  readonly fetchFn?: ThresholdTelegramFetch | undefined;
}

/**
 * Bot API adapter. No retry loop: the caller owns re-offering a failed transition,
 * and the mask is not advanced, so a retry is just the next evaluation.
 */
export function createTelegramThresholdSender(
  options: TelegramThresholdSenderOptions,
): ThresholdAlertSender {
  return async (text) => {
    if (!options.botToken || !options.chatId) {
      return { ok: false, error: "telegram_not_configured" };
    }
    const fetcher: ThresholdTelegramFetch =
      options.fetchFn ?? ((input, init) => fetch(input, init));
    try {
      const response = await fetcher(
        `https://api.telegram.org/bot${options.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: options.chatId,
            text,
            disable_web_page_preview: true,
          }),
        },
      );
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
