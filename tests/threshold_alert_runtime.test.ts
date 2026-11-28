/**
 * @file tests/threshold_alert_runtime.test.ts
 * @description Contract tests for the persisted threshold mask, the commit-on-success
 * evaluation run, and the overlapping-tick guard in the scheduled loop.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BitSet32 } from "../design/domain-branded-types.ts";
import {
  asBasisPoints,
  asBitSet32,
  asCents,
  asDurationMilliseconds,
} from "../lib/bridge_and_channel_router.ts";
import {
  ALERT_BIT,
  type MeasuredDeskSnapshot,
  type MetricReading,
  type ThresholdAlertSender,
  type ThresholdAlertSenderResult,
  type ThresholdPolicy,
} from "../lib/threshold_alert_engine.ts";
import {
  createJsonThresholdStateStore,
  createThresholdAlertLoop,
  runThresholdEvaluation,
  type ThresholdEvaluationResult,
  type ThresholdStateStore,
  type ThresholdTickResult,
} from "../lib/threshold_alert_runtime.ts";

const POLICY: ThresholdPolicy = {
  maxDownlineExposureCents: asCents(1_000_000),
  minPartnerLiquidityRatioBps: asBasisPoints(1_500),
  maxChurnTopDecileLiftBps: asBasisPoints(250),
  maxBridgeLagMs: asDurationMilliseconds(2_000),
};

const UNMEASURED_FIELD_NAMES = [
  "downlineExposureCents",
  "partnerLiquidityRatioBps",
  "churnTopDecileLiftBps",
  "bridgeLagMs",
] as const;

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "threshold-alert-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function measured<T>(value: T): MetricReading<T> {
  return { kind: "measured", value };
}

function measuredReadings(
  overrides: Partial<MeasuredDeskSnapshot> = {},
): MeasuredDeskSnapshot {
  return {
    downlineExposureCents: measured(asCents(500_000)),
    partnerLiquidityRatioBps: measured(asBasisPoints(3_000)),
    churnTopDecileLiftBps: measured(asBasisPoints(100)),
    bridgeLagMs: measured(asDurationMilliseconds(500)),
    ...overrides,
  };
}

function breachReadings(
  overrides: Partial<MeasuredDeskSnapshot> = {},
): MeasuredDeskSnapshot {
  return measuredReadings({
    downlineExposureCents: measured(asCents(1_250_000)),
    partnerLiquidityRatioBps: measured(asBasisPoints(900)),
    churnTopDecileLiftBps: measured(asBasisPoints(400)),
    bridgeLagMs: measured(asDurationMilliseconds(5_000)),
    ...overrides,
  });
}

const allUnmeasured: MeasuredDeskSnapshot = {
  downlineExposureCents: {
    kind: "unmeasured",
    reason: "downline_snapshot_missing",
  },
  partnerLiquidityRatioBps: {
    kind: "unmeasured",
    reason: "partner_endpoint_timeout",
  },
  churnTopDecileLiftBps: {
    kind: "unmeasured",
    reason: "churn_rollup_unavailable",
  },
  bridgeLagMs: { kind: "unmeasured", reason: "bridge_probe_not_sampled" },
};

interface MemoryStoreState {
  mask: BitSet32;
  reads: number;
  writes: BitSet32[];
}

function createMemoryStore(initial: BitSet32 = asBitSet32(0)): {
  store: ThresholdStateStore;
  state: MemoryStoreState;
} {
  const state: MemoryStoreState = {
    mask: initial,
    reads: 0,
    writes: [],
  };
  return {
    store: {
      async read(): Promise<BitSet32> {
        state.reads += 1;
        return state.mask;
      },
      async write(mask: BitSet32): Promise<void> {
        state.mask = mask;
        state.writes.push(mask);
      },
    },
    state,
  };
}

function recordingSender(result: ThresholdAlertSenderResult = { ok: true }): {
  send: ThresholdAlertSender;
  texts: string[];
} {
  const texts: string[] = [];
  return {
    send: async (text) => {
      texts.push(text);
      return result;
    },
    texts,
  };
}

function completedResult(
  result: ThresholdTickResult,
): ThresholdEvaluationResult {
  if (result.status !== "completed") {
    throw new Error(`expected a completed tick, received ${result.status}`);
  }
  return result.result;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

describe("createJsonThresholdStateStore", () => {
  test("reads the empty mask from a missing file", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "threshold-state.json");
    const store = createJsonThresholdStateStore(path);

    expect(await store.read()).toBe(asBitSet32(0));
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("round-trips the mask atomically and leaves no temp file", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "threshold-state.json");
    const store = createJsonThresholdStateStore(path);
    const mask = asBitSet32(
      ALERT_BIT.DOWNLINE_EXPOSURE_BREACH | ALERT_BIT.PARTNER_LIQUIDITY_LOW,
    );

    await store.write(mask);

    expect(await store.read()).toBe(mask);
    expect(await readdir(dir)).toEqual(["threshold-state.json"]);
    const persisted: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toEqual({ mask32: mask });
  });

  test("round-trips the unsigned high bit", async () => {
    const dir = await makeTempDir();
    const store = createJsonThresholdStateStore(join(dir, "state.json"));
    const mask = asBitSet32(1 << 31);

    await store.write(mask);

    expect(await store.read()).toBe(mask);
    expect(await store.read()).toBeGreaterThan(0);
  });

  test("resets a corrupt or malformed file to the empty mask", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "state.json");
    const store = createJsonThresholdStateStore(path);

    await writeFile(path, "{ not json", "utf8");
    expect(await store.read()).toBe(asBitSet32(0));

    await writeFile(path, JSON.stringify({ mask32: "7" }), "utf8");
    expect(await store.read()).toBe(asBitSet32(0));

    await writeFile(path, JSON.stringify({ mask32: -1 }), "utf8");
    expect(await store.read()).toBe(asBitSet32(0));

    await writeFile(path, JSON.stringify({ mask32: 2 ** 32 }), "utf8");
    expect(await store.read()).toBe(asBitSet32(0));

    await writeFile(path, JSON.stringify({}), "utf8");
    expect(await store.read()).toBe(asBitSet32(0));

    // Fail open is a reset, not a dead store: the next write must recover it.
    const mask = asBitSet32(ALERT_BIT.BRIDGE_LAG_SLA_BREACH);
    await store.write(mask);
    expect(await store.read()).toBe(mask);
  });

  test("concurrent writes each rename a complete payload", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "state.json");
    const store = createJsonThresholdStateStore(path);
    const masks = [
      asBitSet32(ALERT_BIT.DOWNLINE_EXPOSURE_BREACH),
      asBitSet32(ALERT_BIT.PARTNER_LIQUIDITY_LOW),
      asBitSet32(
        ALERT_BIT.CHURN_DECILE_SPIKE | ALERT_BIT.BRIDGE_LAG_SLA_BREACH,
      ),
    ];

    await Promise.all(masks.map((mask) => store.write(mask)));

    const winner = await store.read();
    expect(masks).toContain(winner);
    const persisted: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toEqual({ mask32: winner });
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  test("creates a missing parent directory instead of failing", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "nested", "state.json");
    const store = createJsonThresholdStateStore(path);
    const mask = asBitSet32(ALERT_BIT.CHURN_DECILE_SPIKE);

    await store.write(mask);

    expect(await store.read()).toBe(mask);
  });
});

describe("runThresholdEvaluation", () => {
  test("fires a measured breach and commits the widened mask on success", async () => {
    const { store, state } = createMemoryStore();
    const { send, texts } = recordingSender();
    const expectedMask = asBitSet32(
      ALERT_BIT.DOWNLINE_EXPOSURE_BREACH |
        ALERT_BIT.PARTNER_LIQUIDITY_LOW |
        ALERT_BIT.CHURN_DECILE_SPIKE |
        ALERT_BIT.BRIDGE_LAG_SLA_BREACH,
    );

    const result = await runThresholdEvaluation({
      readings: breachReadings(),
      policy: POLICY,
      store,
      send,
    });

    expect(result.delivery).toEqual({ status: "sent" });
    expect(result.newlyTriggeredMask32).toBe(expectedMask);
    expect(result.nextMask32).toBe(expectedMask);
    expect(result.committedMask32).toBe(expectedMask);
    expect(result.unmeasured).toEqual([]);
    expect(state.writes).toEqual([expectedMask]);
    expect(await store.read()).toBe(expectedMask);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("• Partner Liquidity: 9.00%");
  });

  test("an unmeasured low-liquidity reading never fires and never fabricates a line", async () => {
    const { store, state } = createMemoryStore();
    const { send, texts } = recordingSender();
    // Measured, 900 bps would breach the 1,500 bps floor; unmeasured it contributes no bit.
    const readings = breachReadings({
      partnerLiquidityRatioBps: {
        kind: "unmeasured",
        reason: "partner_endpoint_timeout",
      },
    });
    const expectedMask = asBitSet32(
      ALERT_BIT.DOWNLINE_EXPOSURE_BREACH |
        ALERT_BIT.CHURN_DECILE_SPIKE |
        ALERT_BIT.BRIDGE_LAG_SLA_BREACH,
    );

    const result = await runThresholdEvaluation({
      readings,
      policy: POLICY,
      store,
      send,
    });

    expect(result.delivery).toEqual({ status: "sent" });
    expect(result.newlyTriggeredMask32).toBe(expectedMask);
    expect(result.committedMask32).toBe(expectedMask);
    expect(result.unmeasured).toEqual(["partnerLiquidityRatioBps"]);
    expect(state.mask).toBe(expectedMask);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("• Downline Exposure: $12500.00");
    expect(texts[0]).not.toContain("Partner Liquidity");
  });

  test("does nothing and writes nothing when every reading is unmeasured", async () => {
    const { store, state } = createMemoryStore();
    const { send, texts } = recordingSender();

    const result = await runThresholdEvaluation({
      readings: allUnmeasured,
      policy: POLICY,
      store,
      send,
    });

    expect(result.delivery).toEqual({ status: "skipped" });
    expect(result.newlyTriggeredMask32).toBe(asBitSet32(0));
    expect(result.committedMask32).toBe(asBitSet32(0));
    expect(result.unmeasured).toEqual([...UNMEASURED_FIELD_NAMES]);
    expect(state.writes).toEqual([]);
    expect(texts).toEqual([]);
  });

  test("keeps the previous mask when delivery fails, then retries the same transition", async () => {
    const previous = asBitSet32(ALERT_BIT.CHURN_DECILE_SPIKE);
    const { store, state } = createMemoryStore(previous);
    const failedSender = recordingSender({
      ok: false,
      error: "telegram_down",
    });

    const failed = await runThresholdEvaluation({
      readings: breachReadings(),
      policy: POLICY,
      store,
      send: failedSender.send,
    });

    expect(failed.delivery).toEqual({
      status: "failed",
      error: "telegram_down",
    });
    expect(failed.newlyTriggeredMask32).not.toBe(0);
    expect(failed.committedMask32).toBe(previous);
    expect(state.mask).toBe(previous);
    expect(state.writes).toEqual([]);

    const retriedSender = recordingSender();
    const retried = await runThresholdEvaluation({
      readings: breachReadings(),
      policy: POLICY,
      store,
      send: retriedSender.send,
    });

    expect(retried.delivery).toEqual({ status: "sent" });
    expect(retried.newlyTriggeredMask32).toBe(failed.newlyTriggeredMask32);
    expect(retried.committedMask32).toBe(retried.nextMask32);
    expect(state.writes).toEqual([retried.committedMask32]);
    expect(retriedSender.texts).toHaveLength(1);
  });

  test("honors an explicit prev instead of reading the store", async () => {
    const stored = asBitSet32(ALERT_BIT.CHURN_DECILE_SPIKE);
    const { store, state } = createMemoryStore(stored);
    const { send } = recordingSender();

    const result = await runThresholdEvaluation({
      prev: asBitSet32(0),
      readings: breachReadings(),
      policy: POLICY,
      store,
      send,
    });

    expect(state.reads).toBe(0);
    expect(result.newlyTriggeredMask32).toBe(result.nextMask32);
    expect(result.delivery.status).toBe("sent");
    expect(await store.read()).toBe(result.nextMask32);
  });
});

describe("createThresholdAlertLoop", () => {
  test("tickOnce evaluates, sends once, and does not resend a latched transition", async () => {
    const { store, state } = createMemoryStore();
    const { send, texts } = recordingSender();
    const loop = createThresholdAlertLoop({
      intervalMs: 1_000,
      collect: async () => breachReadings(),
      policy: POLICY,
      store,
      send,
    });

    const first = completedResult(await loop.tickOnce());
    expect(first.delivery).toEqual({ status: "sent" });
    expect(texts).toHaveLength(1);

    const second = completedResult(await loop.tickOnce());
    expect(second.delivery).toEqual({ status: "skipped" });
    expect(second.newlyTriggeredMask32).toBe(asBitSet32(0));
    expect(texts).toHaveLength(1);
    expect(state.writes).toHaveLength(1);
  });

  test("a second tick while the first is in flight is busy and does not double-send", async () => {
    let releaseFirstCollect: () => void = () => undefined;
    const firstCollectStarted = new Promise<void>((resolve) => {
      releaseFirstCollect = resolve;
    });
    const { store, state } = createMemoryStore();
    const { send, texts } = recordingSender();
    let collects = 0;
    const loop = createThresholdAlertLoop({
      intervalMs: 1_000,
      collect: async () => {
        collects += 1;
        await firstCollectStarted;
        return breachReadings();
      },
      policy: POLICY,
      store,
      send,
    });

    const first = loop.tickOnce();
    const second = await loop.tickOnce();

    expect(collects).toBe(1);
    expect(second).toEqual({ status: "busy" });
    expect(texts).toEqual([]);

    releaseFirstCollect();
    const result = completedResult(await first);
    expect(result.delivery).toEqual({ status: "sent" });
    expect(texts).toHaveLength(1);
    expect(state.writes).toHaveLength(1);
  });

  test("routes tick errors to onError and never rejects", async () => {
    const { store, state } = createMemoryStore();
    const { send, texts } = recordingSender();
    const errors: unknown[] = [];
    const loop = createThresholdAlertLoop({
      intervalMs: 1_000,
      collect: async () => {
        throw new Error("collector offline");
      },
      policy: POLICY,
      store,
      send,
      onError: (error) => errors.push(error),
    });

    const result = await loop.tickOnce();

    expect(result).toEqual({ status: "failed", error: "collector offline" });
    expect(errors).toHaveLength(1);
    const captured = errors[0];
    if (!(captured instanceof Error)) {
      throw new Error("onError did not receive the thrown Error");
    }
    expect(captured.message).toBe("collector offline");
    expect(texts).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  test("defaults onError to console.error", async () => {
    const { store } = createMemoryStore();
    const { send } = recordingSender();
    const originalConsoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const loop = createThresholdAlertLoop({
        intervalMs: 1_000,
        collect: async () => {
          throw new Error("collector offline");
        },
        policy: POLICY,
        store,
        send,
      });
      await loop.tickOnce();
    } finally {
      console.error = originalConsoleError;
    }

    expect(logged).toHaveLength(1);
  });

  test("start schedules ticks and stop halts them", async () => {
    let collects = 0;
    const { store } = createMemoryStore();
    const { send } = recordingSender();
    const loop = createThresholdAlertLoop({
      intervalMs: 5,
      collect: async () => {
        collects += 1;
        return measuredReadings();
      },
      policy: POLICY,
      store,
      send,
    });

    loop.start();
    loop.start(); // idempotent: re-starting must not add a second timer
    await waitFor(() => collects >= 3, 1_000);
    loop.stop();
    loop.stop();

    await sleep(25);
    const settled = collects;
    await sleep(25);
    expect(collects).toBe(settled);
  });

  test("rejects a non-positive interval", () => {
    expect(() =>
      createThresholdAlertLoop({
        intervalMs: 0,
        collect: async () => measuredReadings(),
        policy: POLICY,
        store: createMemoryStore().store,
        send: async () => ({ ok: true }),
      }),
    ).toThrow(RangeError);
  });
});
