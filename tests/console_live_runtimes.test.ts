/**
 * @file tests/console_live_runtimes.test.ts
 * @description Env gating and wiring for the two live console runtimes. The
 * per-module behavior lives in tests/wager_tick_producer.test.ts and
 * tests/threshold_alert_runtime.test.ts; these cases only prove the daemon shell:
 * off by default, one poll publishes a mapped tick, and an unmeasured alert
 * collector does not call the network.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asCents, asLineHundredths } from "../lib/bridge_and_channel_router.ts";
import type { WagerTickInput } from "../lib/wager_telemetry_hub.ts";
import { startConsoleLiveRuntimes } from "../services/console_live_runtimes.ts";

const WAGER_ROW = {
  WagerNumber: 769_483_646,
  TicketWriter: "GSLIVE",
  AmountWagered: 5_000,
  InsertDateTime: "2026-11-19 18:15:00.487",
  ShortDesc: "S.Football #312 Texans -12.5 -110 - For Game",
} as const;

const BASE = {
  cwd: process.cwd(),
  publishTick: () => undefined,
  bridgeLagMs: () => null,
} as const;

describe("startConsoleLiveRuntimes", () => {
  test("starts nothing when neither flag is set", () => {
    const runtimes = startConsoleLiveRuntimes({ ...BASE, env: {} });

    expect(runtimes.started).toEqual([]);
    expect(runtimes.skipped).toEqual([
      "wager-telemetry:disabled",
      "threshold-alerts:disabled",
    ]);
    expect(runtimes.statusBlock()).toEqual({
      started: [],
      skipped: ["wager-telemetry:disabled", "threshold-alerts:disabled"],
      wagerTelemetry: null,
      thresholdAlerts: null,
    });
    runtimes.stop();
    runtimes.stop();
  });

  test("publishes a mapped tick from the injected row source", async () => {
    const ticks: WagerTickInput[] = [];
    const runtimes = startConsoleLiveRuntimes({
      ...BASE,
      publishTick: (tick) => ticks.push(tick),
      env: {
        SPORTSDESK_WAGER_TELEMETRY: "on",
        SPORTSDESK_WAGER_TELEMETRY_INTERVAL_MS: "1000",
      },
      readLiveWagerRows: async () => [WAGER_ROW],
    });

    for (let attempt = 0; attempt < 40 && ticks.length === 0; attempt++) {
      await Bun.sleep(5);
    }

    expect(runtimes.started).toEqual(["wager-telemetry"]);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.lineHundredths).toBe(asLineHundredths(-1_250));
    expect(ticks[0]?.stakeCents).toBe(asCents(5_000));
    expect(ticks[0]?.wagerId).toBe(769_483_646n);
    const status = runtimes.statusBlock();
    expect(status.wagerTelemetry?.intervalMs).toBe(1_000);
    expect(typeof status.wagerTelemetry?.lastPollAtEpochMs).toBe("number");
    expect(status.thresholdAlerts).toBeNull();

    runtimes.stop();
    const publishedAtStop = ticks.length;
    await Bun.sleep(30);
    expect(ticks).toHaveLength(publishedAtStop);
  });

  test("skips threshold alerts when Telegram is not configured", () => {
    const runtimes = startConsoleLiveRuntimes({
      ...BASE,
      env: { SPORTSDESK_THRESHOLD_ALERTS: "on" },
    });

    expect(runtimes.started).toEqual([]);
    expect(runtimes.skipped).toEqual([
      "wager-telemetry:disabled",
      "threshold-alerts:telegram_not_configured",
    ]);
    expect(runtimes.statusBlock().thresholdAlerts).toBeNull();
    runtimes.stop();
  });

  test("runs an alert tick with an unmeasured lag without touching the network", async () => {
    const statePath = join(
      tmpdir(),
      `console-live-alert-state-${process.pid}-${Date.now()}.json`,
    );
    const runtimes = startConsoleLiveRuntimes({
      ...BASE,
      bridgeLagMs: () => null,
      env: {
        SPORTSDESK_THRESHOLD_ALERTS: "on",
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_CHAT_ID: "test-chat",
        SPORTSDESK_THRESHOLD_STATE_PATH: statePath,
        SPORTSDESK_THRESHOLD_INTERVAL_MS: "60000",
      },
    });

    expect(runtimes.started).toEqual(["threshold-alerts"]);
    expect(runtimes.statusBlock().thresholdAlerts?.intervalMs).toBe(60_000);
    await Bun.sleep(20);
    // No measured metric can breach, so the store is never written.
    expect(existsSync(statePath)).toBe(false);
    runtimes.stop();
  });
});
