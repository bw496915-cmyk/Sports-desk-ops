/**
 * @file tests/threshold_alert_engine.test.ts
 * @description Contract tests for monotonic threshold evaluation and the
 * commit-on-success dispatch rule.
 */

import { describe, expect, test } from "bun:test";
import type {
  BasisPoints,
  BitSet32,
  Cents,
  DurationMilliseconds,
} from "../design/domain-branded-types.ts";
import {
  asBasisPoints,
  asBitSet32,
  asCents,
  asDurationMilliseconds,
} from "../lib/bridge_and_channel_router.ts";
import {
  ALERT_BIT,
  createTelegramThresholdSender,
  dispatchThresholdAlert,
  evaluateAndDispatchThresholdAlert,
  evaluateMonotonicAlerts,
  formatThresholdAlertLines,
  type DeskSnapshotMetrics,
  type ThresholdAlertSender,
  type ThresholdPolicy,
  type ThresholdTelegramFetch,
} from "../lib/threshold_alert_engine.ts";

const POLICY: ThresholdPolicy = {
  maxDownlineExposureCents: asCents(1_000_000),
  minPartnerLiquidityRatioBps: asBasisPoints(1_500),
  maxChurnTopDecileLiftBps: asBasisPoints(250),
  maxBridgeLagMs: asDurationMilliseconds(2_000),
};

function metrics(
  overrides: Partial<DeskSnapshotMetrics> = {},
): DeskSnapshotMetrics {
  return {
    downlineExposureCents: asCents(500_000),
    partnerLiquidityRatioBps: asBasisPoints(3_000),
    churnTopDecileLiftBps: asBasisPoints(100),
    bridgeLagMs: asDurationMilliseconds(500),
    ...overrides,
  };
}

function allBreaches(): DeskSnapshotMetrics {
  return metrics({
    downlineExposureCents: asCents(1_250_000),
    partnerLiquidityRatioBps: asBasisPoints(900),
    churnTopDecileLiftBps: asBasisPoints(400),
    bridgeLagMs: asDurationMilliseconds(5_000),
  });
}

describe("evaluateMonotonicAlerts", () => {
  test("raises one bit per breach and nothing when inside policy", () => {
    expect(
      evaluateMonotonicAlerts(asBitSet32(0), metrics(), POLICY)
        .newlyTriggeredMask32,
    ).toBe(asBitSet32(0));

    const all = evaluateMonotonicAlerts(asBitSet32(0), allBreaches(), POLICY);
    expect(all.newlyTriggeredMask32).toBe(
      asBitSet32(
        ALERT_BIT.DOWNLINE_EXPOSURE_BREACH |
          ALERT_BIT.PARTNER_LIQUIDITY_LOW |
          ALERT_BIT.CHURN_DECILE_SPIKE |
          ALERT_BIT.BRIDGE_LAG_SLA_BREACH,
      ),
    );
    expect(all.nextMask32).toBe(all.newlyTriggeredMask32);
  });

  test("treats a value exactly on the limit as inside policy", () => {
    const onLimit = metrics({
      downlineExposureCents: POLICY.maxDownlineExposureCents,
      partnerLiquidityRatioBps: POLICY.minPartnerLiquidityRatioBps,
      churnTopDecileLiftBps: POLICY.maxChurnTopDecileLiftBps,
      bridgeLagMs: POLICY.maxBridgeLagMs,
    });
    expect(
      evaluateMonotonicAlerts(asBitSet32(0), onLimit, POLICY).nextMask32,
    ).toBe(asBitSet32(0));
  });

  test("never clears a bit when the metric recovers", () => {
    const latched = evaluateMonotonicAlerts(
      asBitSet32(0),
      allBreaches(),
      POLICY,
    ).nextMask32;

    const recovered = evaluateMonotonicAlerts(latched, metrics(), POLICY);

    expect(recovered.nextMask32).toBe(latched);
    expect(recovered.newlyTriggeredMask32).toBe(asBitSet32(0));
  });

  test("reports only the transition bits for a partly-latched mask", () => {
    const previous = asBitSet32(
      ALERT_BIT.CHURN_DECILE_SPIKE | ALERT_BIT.BRIDGE_LAG_SLA_BREACH,
    );
    const evaluation = evaluateMonotonicAlerts(previous, allBreaches(), POLICY);

    expect(evaluation.newlyTriggeredMask32).toBe(
      asBitSet32(
        ALERT_BIT.DOWNLINE_EXPOSURE_BREACH | ALERT_BIT.PARTNER_LIQUIDITY_LOW,
      ),
    );
    expect(evaluation.nextMask32).toBe(
      asBitSet32(previous | evaluation.newlyTriggeredMask32),
    );
  });

  test("stays unsigned when the high bit is already set", () => {
    const previous = asBitSet32(1 << 31);
    const evaluation = evaluateMonotonicAlerts(
      previous,
      metrics({ partnerLiquidityRatioBps: asBasisPoints(1_000) }),
      POLICY,
    );

    expect(evaluation.nextMask32).toBeGreaterThan(0);
    expect(evaluation.nextMask32).toBe(asBitSet32(0x8000_0002));
    expect(evaluation.newlyTriggeredMask32).toBe(
      asBitSet32(ALERT_BIT.PARTNER_LIQUIDITY_LOW),
    );
  });
});

describe("threshold alert formatting and dispatch", () => {
  test("formats every breached metric", () => {
    const lines = formatThresholdAlertLines(
      asBitSet32(
        ALERT_BIT.DOWNLINE_EXPOSURE_BREACH |
          ALERT_BIT.PARTNER_LIQUIDITY_LOW |
          ALERT_BIT.CHURN_DECILE_SPIKE |
          ALERT_BIT.BRIDGE_LAG_SLA_BREACH,
      ),
      allBreaches(),
    );

    expect(lines).toEqual([
      "[SportsDesk Ops] Threshold Breach",
      "• Downline Exposure: $12500.00",
      "• Partner Liquidity: 9.00%",
      "• Churn Top-Decile Lift: 4.00%",
      "• Bridge SLA Lag: 5000ms",
    ]);
  });

  test("formats nothing for an empty transition", () => {
    expect(formatThresholdAlertLines(asBitSet32(0), allBreaches())).toEqual([]);
  });

  test("skips the sender when no bit is newly triggered", async () => {
    let calls = 0;
    const sender: ThresholdAlertSender = async () => {
      calls++;
      return { ok: true };
    };

    const delivery = await dispatchThresholdAlert(
      asBitSet32(0),
      allBreaches(),
      sender,
    );

    expect(delivery).toEqual({ status: "skipped" });
    expect(calls).toBe(0);
  });

  test("sends the formatted text on success", async () => {
    const sent: string[] = [];
    const sender: ThresholdAlertSender = async (text) => {
      sent.push(text);
      return { ok: true };
    };

    const delivery = await dispatchThresholdAlert(
      asBitSet32(ALERT_BIT.DOWNLINE_EXPOSURE_BREACH),
      allBreaches(),
      sender,
    );

    expect(delivery).toEqual({ status: "sent" });
    expect(sent).toEqual([
      "[SportsDesk Ops] Threshold Breach\n• Downline Exposure: $12500.00",
    ]);
  });

  test("turns a sender failure and a throw into a failed delivery", async () => {
    await expect(
      dispatchThresholdAlert(
        asBitSet32(ALERT_BIT.BRIDGE_LAG_SLA_BREACH),
        allBreaches(),
        async () => ({ ok: false, error: "rate_limited" }),
      ),
    ).resolves.toEqual({ status: "failed", error: "rate_limited" });

    await expect(
      dispatchThresholdAlert(
        asBitSet32(ALERT_BIT.BRIDGE_LAG_SLA_BREACH),
        allBreaches(),
        async () => {
          throw new Error("network down");
        },
      ),
    ).resolves.toEqual({ status: "failed", error: "network down" });
  });
});

describe("evaluateAndDispatchThresholdAlert", () => {
  test("commits the widened mask only after a successful send", async () => {
    const outcome = await evaluateAndDispatchThresholdAlert(
      asBitSet32(0),
      allBreaches(),
      POLICY,
      async () => ({ ok: true }),
    );

    expect(outcome.delivery).toEqual({ status: "sent" });
    expect(outcome.committedMask32).toBe(outcome.nextMask32);
  });

  test("keeps the previous mask when delivery fails, so the transition retries", async () => {
    const previous = asBitSet32(0);
    const outcome = await evaluateAndDispatchThresholdAlert(
      previous,
      allBreaches(),
      POLICY,
      async () => ({ ok: false, error: "telegram_down" }),
    );

    expect(outcome.delivery).toEqual({
      status: "failed",
      error: "telegram_down",
    });
    expect(outcome.newlyTriggeredMask32).not.toBe(0);
    expect(outcome.committedMask32).toBe(previous);
  });

  test("does not call the sender when nothing is newly triggered", async () => {
    let calls = 0;
    const outcome = await evaluateAndDispatchThresholdAlert(
      asBitSet32(ALERT_BIT.DOWNLINE_EXPOSURE_BREACH),
      metrics(),
      POLICY,
      async () => {
        calls++;
        return { ok: true };
      },
    );

    expect(outcome.delivery).toEqual({ status: "skipped" });
    expect(outcome.committedMask32).toBe(
      asBitSet32(ALERT_BIT.DOWNLINE_EXPOSURE_BREACH),
    );
    expect(calls).toBe(0);
  });
});

describe("createTelegramThresholdSender", () => {
  interface CapturedRequest {
    readonly url: string;
    readonly body: unknown;
  }

  function fakeFetch(response: Response): {
    fetchFn: ThresholdTelegramFetch;
    calls: CapturedRequest[];
  } {
    const calls: CapturedRequest[] = [];
    const fetchFn: ThresholdTelegramFetch = async (input, init) => {
      const url = input;
      const rawBody = init?.body === undefined ? "" : String(init.body);
      calls.push({ url, body: rawBody === "" ? null : JSON.parse(rawBody) });
      return response;
    };
    return { fetchFn, calls };
  }

  test("posts to the Bot API with the text and no web preview", async () => {
    const { fetchFn, calls } = fakeFetch(new Response("{}", { status: 200 }));
    const send = createTelegramThresholdSender({
      botToken: "TOKEN",
      chatId: "CHAT",
      fetchFn,
    });

    await expect(send("hello")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(calls[0]!.body).toEqual({
      chat_id: "CHAT",
      text: "hello",
      disable_web_page_preview: true,
    });
  });

  test("reports an HTTP failure without throwing", async () => {
    const { fetchFn } = fakeFetch(new Response("nope", { status: 500 }));
    const send = createTelegramThresholdSender({
      botToken: "TOKEN",
      chatId: "CHAT",
      fetchFn,
    });

    await expect(send("hello")).resolves.toEqual({
      ok: false,
      error: "HTTP 500",
    });
  });

  test("reports a transport throw as a failure result", async () => {
    const fetchFn: ThresholdTelegramFetch = async () => {
      throw new Error("connection refused");
    };
    const send = createTelegramThresholdSender({
      botToken: "TOKEN",
      chatId: "CHAT",
      fetchFn,
    });

    await expect(send("hello")).resolves.toEqual({
      ok: false,
      error: "connection refused",
    });
  });

  test("does not call the network when configuration is missing", async () => {
    let calls = 0;
    const fetchFn: ThresholdTelegramFetch = async () => {
      calls++;
      return new Response("{}", { status: 200 });
    };
    const send = createTelegramThresholdSender({
      botToken: "",
      chatId: "CHAT",
      fetchFn,
    });

    await expect(send("hello")).resolves.toEqual({
      ok: false,
      error: "telegram_not_configured",
    });
    expect(calls).toBe(0);
  });
});

// Keep the branded unit imports honest: these are the types the policy above uses.
const brandedUnits: readonly [
  Cents,
  BasisPoints,
  BasisPoints,
  DurationMilliseconds,
  BitSet32,
] = [
  POLICY.maxDownlineExposureCents,
  POLICY.minPartnerLiquidityRatioBps,
  POLICY.maxChurnTopDecileLiftBps,
  POLICY.maxBridgeLagMs,
  asBitSet32(0),
];

test("policy values keep their branded unit types", () => {
  expect(brandedUnits).toHaveLength(5);
});
