/**
 * @file tests/console_live_adversarial.test.ts
 * @description Independent adversarial verification of the console live slice: the live
 * wager-tick producer, the partial-metric threshold alert runtime, and the env-gated
 * console runtimes wired into `startServer`.
 *
 * These cases deliberately stay on the outside of the modules: they feed wire-shaped
 * rows, real captured fixtures, gated promises, failing stores/senders and the real
 * daemon hook, then assert what the current tree does. No case asserts a value that the
 * verifier believes is correct-but-currently-failing; suspected defects are reported
 * with a repro instead of being pinned here as green.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { BridgeChannelPackedWord32 } from "../design/domain-branded-types.ts";
import {
  asBasisPoints,
  asBitSet32,
  asCents,
  asDurationMilliseconds,
  asLineHundredths,
} from "../lib/bridge_and_channel_router.ts";
import { liveWagerRows } from "../lib/customer_source_rows.ts";
import {
  ALERT_BIT,
  type MeasuredDeskSnapshot,
  type MetricReading,
  type ThresholdAlertSender,
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
import {
  asWallEpochMs,
  type WagerTickInput,
} from "../lib/wager_telemetry_hub.ts";
import {
  createWagerTickProducer,
  F402_BRIDGE_ROUTE_WORD32,
  GSLIVE_BRIDGE_ROUTE_WORD32,
  parseTickLineHundredths,
  wagerRowToTick,
  type LiveWagerRow,
} from "../lib/wager_tick_producer.ts";
import { startConsoleLiveRuntimes } from "../services/console_live_runtimes.ts";
import {
  publishWagerTick,
  startServer,
  stopBridgeHub,
} from "../services/sportsdesk_webview_server.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LIVE_WAGERS_PATH = join(REPO_ROOT, "data", "live-wagers.json");
const FIXTURE_DIR = join(import.meta.dir, "fixtures");

const POLICY: ThresholdPolicy = {
  maxDownlineExposureCents: asCents(1_000_000),
  minPartnerLiquidityRatioBps: asBasisPoints(1_500),
  maxChurnTopDecileLiftBps: asBasisPoints(250),
  maxBridgeLagMs: asDurationMilliseconds(2_000),
};

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "console-live-adversarial-"));
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

function unmeasured<T>(reason: string): MetricReading<T> {
  return { kind: "unmeasured", reason };
}

function healthyReadings(
  overrides: Partial<MeasuredDeskSnapshot> = {},
): MeasuredDeskSnapshot {
  return {
    downlineExposureCents: measured(asCents(1)),
    partnerLiquidityRatioBps: measured(asBasisPoints(99_999)),
    churnTopDecileLiftBps: measured(asBasisPoints(1)),
    bridgeLagMs: measured(asDurationMilliseconds(1)),
    ...overrides,
  };
}

function breachReadings(
  overrides: Partial<MeasuredDeskSnapshot> = {},
): MeasuredDeskSnapshot {
  return healthyReadings({
    downlineExposureCents: measured(
      asCents(POLICY.maxDownlineExposureCents + 1),
    ),
    partnerLiquidityRatioBps: measured(
      asBasisPoints(POLICY.minPartnerLiquidityRatioBps - 1),
    ),
    churnTopDecileLiftBps: measured(
      asBasisPoints(POLICY.maxChurnTopDecileLiftBps + 1),
    ),
    bridgeLagMs: measured(asDurationMilliseconds(POLICY.maxBridgeLagMs + 1)),
    ...overrides,
  });
}

interface MemoryStoreState {
  mask: number;
  writes: number[];
}

function createMemoryStore(initial: number = 0): {
  store: ThresholdStateStore;
  state: MemoryStoreState;
} {
  const state: MemoryStoreState = { mask: initial, writes: [] };
  return {
    store: {
      async read() {
        return asBitSet32(state.mask);
      },
      async write(mask) {
        state.mask = mask;
        state.writes.push(mask);
      },
    },
    state,
  };
}

function recordingSender(
  result: { ok: boolean; error?: string } = { ok: true },
): { send: ThresholdAlertSender; texts: string[] } {
  const texts: string[] = [];
  return {
    send: async (text) => {
      texts.push(text);
      return result;
    },
    texts,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await Bun.sleep(2);
  }
}

interface IntervalSpy {
  readonly delays: number[];
  unrefs: number;
  cleared: number;
}

/**
 * Replace the global interval functions while a start/stop pair runs. The fake returns a
 * bare object with `unref` and records `clearInterval`, so nothing can outlive the test.
 */
function spyIntervals(): { spy: IntervalSpy; restore: () => void } {
  const target = globalThis as unknown as Record<string, unknown>;
  const realSetInterval = target.setInterval;
  const realClearInterval = target.clearInterval;
  const spy: IntervalSpy = { delays: [], unrefs: 0, cleared: 0 };
  target.setInterval = (_handler: unknown, delay?: number) => {
    spy.delays.push(Number(delay));
    return {
      unref: () => {
        spy.unrefs += 1;
      },
    };
  };
  target.clearInterval = () => {
    spy.cleared += 1;
  };
  return {
    spy,
    restore: () => {
      target.setInterval = realSetInterval;
      target.clearInterval = realClearInterval;
    },
  };
}

const bunEnv = Bun.env as unknown as Record<string, string | undefined>;

async function withEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) saved.set(key, bunEnv[key]);
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete bunEnv[key];
      else bunEnv[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete bunEnv[key];
      else bunEnv[key] = value;
    }
  }
}

async function loadFixtureRows(
  name: string,
): Promise<readonly Record<string, unknown>[]> {
  const raw: unknown = await Bun.file(join(FIXTURE_DIR, name)).json();
  return liveWagerRows(raw);
}

function liveRow(overrides: Partial<LiveWagerRow> = {}): LiveWagerRow {
  return {
    WagerNumber: 769_500_001,
    TicketWriter: "Internet",
    AmountWagered: 10_000,
    InsertDateTime: "2026-11-19 18:20:02.280",
    ShortDesc: "-3.5",
    ...overrides,
  };
}

function expectTick(row: LiveWagerRow): WagerTickInput {
  const tick = wagerRowToTick(row);
  if (tick === null) throw new Error("expected the row to map to a tick");
  return tick;
}

function completedResult(
  result: ThresholdTickResult,
): ThresholdEvaluationResult {
  if (result.status !== "completed") {
    throw new Error(`expected a completed tick, received ${result.status}`);
  }
  return result.result;
}

/* -------------------------------------------------------------------------- */
/* Producer: parser + row mapping                                             */
/* -------------------------------------------------------------------------- */

describe("wager tick producer: wire grammars", () => {
  test("maps the documented single-selection forms to exact hundredths", () => {
    expect(parseTickLineHundredths("+3.5")).toBe(asLineHundredths(350));
    expect(parseTickLineHundredths("-3.5")).toBe(asLineHundredths(-350));
    expect(parseTickLineHundredths("-12.5")).toBe(asLineHundredths(-1_250));
    expect(parseTickLineHundredths("+17.5")).toBe(asLineHundredths(1_750));
    expect(parseTickLineHundredths("Over 46.5")).toBe(asLineHundredths(4_650));
    expect(parseTickLineHundredths("Under 46.5")).toBe(asLineHundredths(4_650));
    expect(parseTickLineHundredths("O 44")).toBe(asLineHundredths(4_400));
    expect(parseTickLineHundredths("U 6")).toBe(asLineHundredths(600));
    expect(parseTickLineHundredths("PK")).toBe(asLineHundredths(0));
    expect(parseTickLineHundredths("pk")).toBe(asLineHundredths(0));
    expect(parseTickLineHundredths("0")).toBe(asLineHundredths(0));
    // Spread/total descriptions keep only the line token immediately before the price.
    expect(
      parseTickLineHundredths("S.Football #312 Texans -12½ -110 - For Game"),
    ).toBe(asLineHundredths(-1_250));
    expect(
      parseTickLineHundredths(
        "M.G319748913\r\nFootball - Denver Broncos vs Kansas City Chiefs / Game / Total / Over 46.5 -108&#x0D;\n",
      ),
    ).toBe(asLineHundredths(4_650));
    expect(
      parseTickLineHundredths("S.Basketball #761 Texas A&M PK -110 - For Game"),
    ).toBe(asLineHundredths(0));
  });

  test("moneyline and odds-only descriptions yield no line", () => {
    const noLine: readonly string[] = [
      "G Knights -125 - For Game",
      "Hockey #52 G Knights -125 - For Game",
      "M.Hockey #47 Ducks +110 - For Game",
      "Tyler Warren 1st Touchdown +600",
      "Tyler Warren +2000 for Game",
      "P.G319747616\r\nFootball - Los Angeles Rams vs Los Angeles Chargers / Game / Winner (2 way) / Los Angeles Rams -140&#x0D;\n",
    ];
    for (const shortDesc of noLine) {
      expect(parseTickLineHundredths(shortDesc)).toBeNull();
    }
    // A bare American price is odds, never a 140-point spread.
    expect(parseTickLineHundredths("-140")).toBeNull();
    expect(parseTickLineHundredths("+600")).toBeNull();
  });

  test("detects priced parlays when the two lines differ", () => {
    expect(
      parseTickLineHundredths(
        "S.Football #1 Americans -3.5 -110 / S.Football #2 Nationals +4.5 -105",
      ),
    ).toBeNull();
    // Real captured fixture grammar: a points-buy leg plus a different total leg.
    expect(
      parseTickLineHundredths(
        "P.Football #263 Eagles  8 -160 - buying 2 For Game Football #263 Eagles/Commanders O 38½ -150 - For Game ",
      ),
    ).toBeNull();
    expect(
      parseTickLineHundredths(
        "Basketball - Clippers vs Warriors / Total / Over 11.5 -343\nBasketball - Clippers vs Warriors / Total / Over 7.5 -350",
      ),
    ).toBeNull();
  });

  test("normalizes CR/LF, tags, entities and fraction entities the feed carries", () => {
    expect(parseTickLineHundredths("-3.5\r\n")).toBe(asLineHundredths(-350));
    expect(parseTickLineHundredths("  +3.5 ")).toBe(asLineHundredths(350));
    expect(parseTickLineHundredths("-3.5&#x0D;&#x0D;")).toBe(
      asLineHundredths(-350),
    );
    expect(parseTickLineHundredths("-1&#189;")).toBe(asLineHundredths(-150));
    expect(parseTickLineHundredths("+17&#189;")).toBe(asLineHundredths(1_750));
    expect(parseTickLineHundredths("-1½")).toBe(asLineHundredths(-150));
    expect(parseTickLineHundredths("&frac12;")).toBe(asLineHundredths(50));
    expect(parseTickLineHundredths("Over&nbsp;143.5")).toBe(
      asLineHundredths(14_350),
    );
    expect(parseTickLineHundredths("<b>Over 143.5</b>")).toBe(
      asLineHundredths(14_350),
    );
    expect(
      parseTickLineHundredths(
        "Football - A vs B / Total / Over 3&#189; -110&#x0D;",
      ),
    ).toBe(asLineHundredths(350));
  });

  test("malformed expressions return null instead of throwing", () => {
    const malformed: readonly string[] = [
      "",
      "   ",
      "\r\n",
      "3.141",
      "3.",
      "+",
      "Push",
      "3.5/4.5",
    ];
    for (const shortDesc of malformed) {
      expect(parseTickLineHundredths(shortDesc)).toBeNull();
    }
    expect(parseTickLineHundredths(42 as unknown as string)).toBeNull();
    expect(parseTickLineHundredths(null as unknown as string)).toBeNull();
  });
});

describe("wager tick producer: row mapping", () => {
  test("maps a real captured row to the exact tick fields", async () => {
    const rows = await loadFixtureRows("live-wagers-list-sample.json");
    const totalRow = rows.find((row) => row.WagerNumber === 767_126_203);
    const spreadRow = rows.find((row) => row.WagerNumber === 767_126_258);
    if (totalRow === undefined || spreadRow === undefined) {
      throw new Error("expected the captured sample rows");
    }

    const totalTick = expectTick(totalRow as unknown as LiveWagerRow);
    expect(totalTick.routeWord32).toBe(GSLIVE_BRIDGE_ROUTE_WORD32);
    expect(totalTick.lineHundredths).toBe(asLineHundredths(4_650));
    expect(totalTick.stakeCents).toBe(asCents(21_600));
    expect(totalTick.wagerId).toBe(767_126_203n);
    expect(totalTick.wallEpochMs).toBe(
      asWallEpochMs(Date.UTC(2026, 10, 1, 22, 18, 20, 453)),
    );

    const spreadTick = expectTick(spreadRow as unknown as LiveWagerRow);
    expect(spreadTick.routeWord32).toBe(F402_BRIDGE_ROUTE_WORD32);
    expect(spreadTick.lineHundredths).toBe(asLineHundredths(-200));
    expect(spreadTick.stakeCents).toBe(asCents(1_430));
    expect(spreadTick.wagerId).toBe(767_126_258n);
    expect(spreadTick.wallEpochMs).toBe(
      asWallEpochMs(Date.UTC(2026, 10, 1, 22, 18, 55, 857)),
    );
  });

  test("routes by the trimmed, case-insensitive writer and defaults every other writer", () => {
    const writers: readonly (readonly [unknown, BridgeChannelPackedWord32])[] =
      [
        [" GSLIVE  ", GSLIVE_BRIDGE_ROUTE_WORD32],
        ["gslive", GSLIVE_BRIDGE_ROUTE_WORD32],
        [" Gslive ", GSLIVE_BRIDGE_ROUTE_WORD32],
        ["GSBUILDER", F402_BRIDGE_ROUTE_WORD32],
        ["Internet", F402_BRIDGE_ROUTE_WORD32],
        ["ALERT", F402_BRIDGE_ROUTE_WORD32],
        ["", F402_BRIDGE_ROUTE_WORD32],
      ];
    for (const [writer, route] of writers) {
      expect(expectTick(liveRow({ TicketWriter: writer })).routeWord32).toBe(
        route,
      );
    }
    expect(wagerRowToTick(liveRow({ TicketWriter: 42 }))).toBeNull();
    expect(wagerRowToTick(liveRow({ TicketWriter: undefined }))).toBeNull();
  });

  test("accepts the boundary stake and wager id, rejects malformed numbers", () => {
    const boundary = expectTick(
      liveRow({
        WagerNumber: 0,
        AmountWagered: 0x7fff_ffff,
      }),
    );
    expect(boundary.wagerId).toBe(0n);
    expect(boundary.stakeCents).toBe(asCents(0x7fff_ffff));

    const badNumber: readonly unknown[] = [
      "769500001",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      undefined,
    ];
    for (const WagerNumber of badNumber) {
      expect(wagerRowToTick(liveRow({ WagerNumber }))).toBeNull();
    }
    const badStake: readonly unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0x8000_0000,
      "10000",
      null,
    ];
    for (const AmountWagered of badStake) {
      expect(wagerRowToTick(liveRow({ AmountWagered }))).toBeNull();
    }
  });

  test("reads only a complete portal wall clock and rejects unsafe dates", () => {
    const endOfDay = expectTick(
      liveRow({ InsertDateTime: "2026-11-19 23:59:59.999" }),
    );
    expect(endOfDay.wallEpochMs).toBe(
      asWallEpochMs(Date.UTC(2026, 10, 20, 4, 59, 59, 999)),
    );
    // The wire separator is accepted, and surrounding whitespace is trimmed.
    expect(
      expectTick(liveRow({ InsertDateTime: "2026-11-19T18:20:02.280" }))
        .wallEpochMs,
    ).toBe(asWallEpochMs(Date.UTC(2026, 10, 19, 23, 20, 2, 280)));
    expect(
      expectTick(liveRow({ InsertDateTime: " 2026-11-19 18:20:02.280 " }))
        .wallEpochMs,
    ).toBe(asWallEpochMs(Date.UTC(2026, 10, 19, 23, 20, 2, 280)));
    expect(
      expectTick(liveRow({ InsertDateTime: "2028-02-29 12:00:00.000" }))
        .wallEpochMs,
    ).toBe(asWallEpochMs(Date.UTC(2028, 1, 29, 17, 0, 0, 0)));

    const unsafe: readonly unknown[] = [
      undefined,
      null,
      42,
      "",
      "not-a-date",
      "2026-02-30 12:00:00.000",
      "2026-13-01 00:00:00.000",
      "2026-11-19 24:00:00.000",
      "2026-11-19 18:20:02.280Z",
      "0000-01-01 00:00:00.000",
    ];
    for (const InsertDateTime of unsafe) {
      expect(wagerRowToTick(liveRow({ InsertDateTime }))).toBeNull();
    }
    expect(wagerRowToTick(liveRow({ ShortDesc: undefined }))).toBeNull();
    expect(wagerRowToTick(liveRow({ ShortDesc: 42 }))).toBeNull();
    expect(wagerRowToTick(null as unknown as LiveWagerRow)).toBeNull();
  });
});

describe("wager tick producer: polling", () => {
  const validRows: readonly LiveWagerRow[] = [
    liveRow({ WagerNumber: 101, TicketWriter: "GSLIVE", ShortDesc: "+3.5" }),
    liveRow({ WagerNumber: 102, ShortDesc: "Over 143.5" }),
    liveRow({ WagerNumber: 103, ShortDesc: " PK -110" }),
    liveRow({ WagerNumber: 104, ShortDesc: "G Knights -125 - For Game" }),
    liveRow({ WagerNumber: 105, AmountWagered: -1 }),
  ];

  test("publishes the whole valid window on the first poll and nothing on the next", async () => {
    const published: bigint[] = [];
    const rows = [validRows[0]!, validRows[1]!, validRows[3]!, validRows[4]!];
    const producer = createWagerTickProducer({
      readRows: async () => rows,
      publish: (tick) => published.push(tick.wagerId),
      now: () => 1,
    });

    expect(await producer.pollOnce()).toEqual({
      read: 4,
      published: 2,
      skippedNoLine: 1,
      skippedInvalid: 1,
    });
    expect(await producer.pollOnce()).toEqual({
      read: 4,
      published: 0,
      skippedNoLine: 1,
      skippedInvalid: 1,
    });
    expect(published).toEqual([101n, 102n]);
  });

  test("a fresh producer replays the whole still-valid window (daemon restart)", async () => {
    const rows = [validRows[0]!, validRows[1]!, validRows[2]!];
    const firstProcess: bigint[] = [];
    const first = createWagerTickProducer({
      readRows: async () => rows,
      publish: (tick) => firstProcess.push(tick.wagerId),
    });
    expect((await first.pollOnce()).published).toBe(3);

    // The dedupe set is in-memory only: the restarted producer re-publishes the window.
    const restartedProcess: bigint[] = [];
    const restarted = createWagerTickProducer({
      readRows: async () => rows,
      publish: (tick) => restartedProcess.push(tick.wagerId),
    });
    expect((await restarted.pollOnce()).published).toBe(3);
    expect(restartedProcess).toEqual(firstProcess);
  });

  test("dedupes WagerNumbers within and across polls", async () => {
    const published: bigint[] = [];
    let poll = 0;
    const producer = createWagerTickProducer({
      readRows: async () =>
        poll++ === 0
          ? [validRows[0]!, validRows[0]!, validRows[1]!]
          : [validRows[0]!, validRows[1]!],
      publish: (tick) => published.push(tick.wagerId),
    });
    expect((await producer.pollOnce()).published).toBe(2);
    expect((await producer.pollOnce()).published).toBe(0);
    expect(published).toEqual([101n, 102n]);
  });

  test("a line-less wager can publish once a later poll carries a line", async () => {
    const published: bigint[] = [];
    let poll = 0;
    const producer = createWagerTickProducer({
      readRows: async () =>
        poll++ === 0
          ? [liveRow({ WagerNumber: 201, ShortDesc: "G Knights -125" })]
          : [liveRow({ WagerNumber: 201, ShortDesc: "-3.5" })],
      publish: (tick) => published.push(tick.wagerId),
    });
    expect(await producer.pollOnce()).toEqual({
      read: 1,
      published: 0,
      skippedNoLine: 1,
      skippedInvalid: 0,
    });
    expect((await producer.pollOnce()).published).toBe(1);
    expect(published).toEqual([201n]);
  });

  test("a throwing publish aborts the poll and retries that wager exactly once", async () => {
    const rows = [
      liveRow({ WagerNumber: 301 }),
      liveRow({ WagerNumber: 302 }),
      liveRow({ WagerNumber: 303 }),
    ];
    const published: bigint[] = [];
    const seenIds: bigint[] = [];
    const poison = 302n;
    let poisonThrown = false;
    const producer = createWagerTickProducer({
      readRows: async () => rows,
      publish: (tick) => {
        if (tick.wagerId === poison && !poisonThrown) {
          poisonThrown = true;
          throw new Error("publish aborted");
        }
        seenIds.push(tick.wagerId);
        published.push(tick.wagerId);
      },
    });

    await expect(producer.pollOnce()).rejects.toThrow("publish aborted");
    expect(published).toEqual([301n]);
    expect((await producer.pollOnce()).published).toBe(2);
    expect(published).toEqual([301n, 302n, 303n]);
    expect(seenIds).toEqual([301n, 302n, 303n]);
  });

  test("overlapping polls never double-publish a wager", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const published: bigint[] = [];
    const producer = createWagerTickProducer({
      readRows: async () => {
        await gate;
        return [validRows[0]!, validRows[1]!, validRows[2]!];
      },
      publish: (tick) => published.push(tick.wagerId),
    });

    const first = producer.pollOnce();
    const second = producer.pollOnce();
    release();
    const results = await Promise.all([first, second]);

    expect(results[0]!.published + results[1]!.published).toBe(3);
    expect(published).toEqual([101n, 102n, 103n]);
  });

  test("a rejecting row source propagates and publishes nothing", async () => {
    const published: bigint[] = [];
    const producer = createWagerTickProducer({
      readRows: async () => {
        throw new Error("reader offline");
      },
      publish: (tick) => published.push(tick.wagerId),
      now: () => 1_700_000_000_000,
    });
    await expect(producer.pollOnce()).rejects.toThrow("reader offline");
    expect(published).toEqual([]);
    expect(producer.lastPollAtEpochMs).toBe(1_700_000_000_000);
  });

  // The production runtime reads this exact artifact; when an operator checkout has one,
  // the invariants must hold. Absent (the committed tree) the case is skipped.
  test.skipIf(!existsSync(LIVE_WAGERS_PATH))(
    "the live ticker artifact stays internally consistent through two polls",
    async () => {
      const raw: unknown = await Bun.file(LIVE_WAGERS_PATH).json();
      const rows = liveWagerRows(raw);
      const publishedIds = new Set<bigint>();
      const producer = createWagerTickProducer({
        readRows: async () => rows,
        publish: (tick) => publishedIds.add(tick.wagerId),
      });
      const first = await producer.pollOnce();
      const second = await producer.pollOnce();

      expect(first.read).toBe(rows.length);
      expect(second.read).toBe(rows.length);
      // Duplicate WagerNumbers are deduped and counted in no bucket, so the counted
      // categories can add up to less than `read`; they must never add up to more.
      expect(
        first.published + first.skippedNoLine + first.skippedInvalid,
      ).toBeLessThanOrEqual(first.read);
      expect(second.published).toBe(0);
      expect(publishedIds.size).toBe(first.published);
      for (const wagerId of publishedIds) {
        expect(wagerId).toBeGreaterThanOrEqual(0n);
      }
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Threshold alert runtime                                                    */
/* -------------------------------------------------------------------------- */

describe("threshold alert runtime: measured semantics", () => {
  test("unmeasured liquidity, churn and downline cannot fire beside a measured lag breach", async () => {
    const { store, state } = createMemoryStore();
    const { send, texts } = recordingSender();
    const readings: MeasuredDeskSnapshot = {
      downlineExposureCents: unmeasured("downline collector offline"),
      partnerLiquidityRatioBps: unmeasured("partner endpoint timeout"),
      churnTopDecileLiftBps: unmeasured("churn rollup unavailable"),
      bridgeLagMs: measured(asDurationMilliseconds(5_000)),
    };

    const result = await runThresholdEvaluation({
      readings,
      policy: POLICY,
      store,
      send,
    });

    expect(result.delivery).toEqual({ status: "sent" });
    expect(result.newlyTriggeredMask32).toBe(
      asBitSet32(ALERT_BIT.BRIDGE_LAG_SLA_BREACH),
    );
    expect(result.unmeasured).toEqual([
      "downlineExposureCents",
      "partnerLiquidityRatioBps",
      "churnTopDecileLiftBps",
    ]);
    expect(state.writes).toEqual([ALERT_BIT.BRIDGE_LAG_SLA_BREACH]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Bridge SLA Lag: 5000ms");
    expect(texts[0]).not.toContain("Downline Exposure");
    expect(texts[0]).not.toContain("Partner Liquidity");
    expect(texts[0]).not.toContain("Churn Top-Decile");
  });

  test("a measured bridge lag fires strictly above the policy limit", async () => {
    const atLimit = createMemoryStore();
    const atResult = await runThresholdEvaluation({
      readings: healthyReadings({
        bridgeLagMs: measured(asDurationMilliseconds(POLICY.maxBridgeLagMs)),
      }),
      policy: POLICY,
      store: atLimit.store,
      send: recordingSender().send,
    });
    expect(atResult.delivery).toEqual({ status: "skipped" });
    expect(atResult.newlyTriggeredMask32).toBe(asBitSet32(0));
    expect(atLimit.state.writes).toEqual([]);

    const above = createMemoryStore();
    const { send, texts } = recordingSender();
    const aboveResult = await runThresholdEvaluation({
      readings: healthyReadings({
        bridgeLagMs: measured(
          asDurationMilliseconds(POLICY.maxBridgeLagMs + 1),
        ),
      }),
      policy: POLICY,
      store: above.store,
      send,
    });
    expect(aboveResult.delivery).toEqual({ status: "sent" });
    expect(aboveResult.newlyTriggeredMask32).toBe(
      asBitSet32(ALERT_BIT.BRIDGE_LAG_SLA_BREACH),
    );
    expect(above.state.writes).toEqual([ALERT_BIT.BRIDGE_LAG_SLA_BREACH]);
    expect(texts).toHaveLength(1);
  });

  test("a failed or throwing sender leaves the mask and the state file unchanged", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "state.json");
    const store = createJsonThresholdStateStore(path);
    const previous = asBitSet32(ALERT_BIT.CHURN_DECILE_SPIKE);
    await store.write(previous);

    const failed = await runThresholdEvaluation({
      readings: breachReadings(),
      policy: POLICY,
      store,
      send: recordingSender({ ok: false, error: "telegram_down" }).send,
    });
    expect(failed.delivery).toEqual({
      status: "failed",
      error: "telegram_down",
    });
    expect(failed.committedMask32).toBe(previous);
    expect(await store.read()).toBe(previous);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mask32: previous,
    });

    const throwing = await runThresholdEvaluation({
      readings: breachReadings(),
      policy: POLICY,
      store,
      send: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(throwing.delivery).toEqual({
      status: "failed",
      error: "socket hang up",
    });
    expect(throwing.committedMask32).toBe(previous);
    expect(await store.read()).toBe(previous);

    // The same transition is offered again and commits on the next success.
    const { send, texts } = recordingSender();
    const retried = await runThresholdEvaluation({
      readings: breachReadings(),
      policy: POLICY,
      store,
      send,
    });
    expect(retried.delivery).toEqual({ status: "sent" });
    expect(retried.newlyTriggeredMask32).toBe(throwing.newlyTriggeredMask32);
    expect(texts).toHaveLength(1);
    expect(await store.read()).toBe(retried.committedMask32);
  });

  test("a failed state write rejects without committing and re-offers the transition", async () => {
    const state = { mask: 0, writes: 0 };
    const failingOnce: ThresholdStateStore = {
      async read() {
        return asBitSet32(state.mask);
      },
      async write(mask) {
        state.writes += 1;
        if (state.writes === 1) throw new Error("disk full");
        state.mask = mask;
      },
    };
    const { send, texts } = recordingSender();

    await expect(
      runThresholdEvaluation({
        readings: breachReadings(),
        policy: POLICY,
        store: failingOnce,
        send,
      }),
    ).rejects.toThrow("disk full");
    expect(state.mask).toBe(0);

    const retried = await runThresholdEvaluation({
      readings: breachReadings(),
      policy: POLICY,
      store: failingOnce,
      send,
    });
    expect(retried.delivery).toEqual({ status: "sent" });
    expect(state.writes).toBe(2);
    expect(state.mask).toBe(retried.committedMask32);
    // At-least-once: the transition was messaged once per evaluation attempt.
    expect(texts).toHaveLength(2);
  });

  test("corrupt, missing and partial state files read as the empty mask", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "state.json");
    const store = createJsonThresholdStateStore(path);

    expect(await store.read()).toBe(asBitSet32(0));
    const cases: readonly (readonly [string, number])[] = [
      ["", 0],
      ['{"mask32": 7', 0],
      ["null", 0],
      ["[]", 0],
      ['{"mask32": 3.5}', 0],
      ['{"mask32": -1}', 0],
      ['{"mask32": 4294967296}', 0],
      ['{"mask32": "3"}', 0],
      ['{"mask": 3}', 0],
      ['{"mask32": 7} trailing', 0],
      ['{"mask32": 3}', 3],
      ['{"mask32": 2, "note": "kept"}', 2],
      ['{"mask32": 2147483648}', 2_147_483_648],
    ];
    for (const [text, expected] of cases) {
      await writeFile(path, text, "utf8");
      expect(await store.read()).toBe(asBitSet32(expected));
    }
  });

  test("a latched state-file bit is not re-alerted when another metric breaches", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "state.json");
    const store = createJsonThresholdStateStore(path);
    await store.write(asBitSet32(ALERT_BIT.CHURN_DECILE_SPIKE));
    const { send, texts } = recordingSender();

    const first = await runThresholdEvaluation({
      readings: breachReadings({
        churnTopDecileLiftBps: unmeasured("churn rollup unavailable"),
      }),
      policy: POLICY,
      store,
      send,
    });
    expect(first.newlyTriggeredMask32).toBe(
      asBitSet32(
        ALERT_BIT.DOWNLINE_EXPOSURE_BREACH |
          ALERT_BIT.PARTNER_LIQUIDITY_LOW |
          ALERT_BIT.BRIDGE_LAG_SLA_BREACH,
      ),
    );
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toContain("Churn Top-Decile");

    const second = await runThresholdEvaluation({
      readings: breachReadings({
        churnTopDecileLiftBps: unmeasured("churn rollup unavailable"),
      }),
      policy: POLICY,
      store,
      send,
    });
    expect(second.delivery).toEqual({ status: "skipped" });
    expect(second.newlyTriggeredMask32).toBe(asBitSet32(0));
    expect(texts).toHaveLength(1);
    expect(await store.read()).toBe(
      asBitSet32(
        ALERT_BIT.DOWNLINE_EXPOSURE_BREACH |
          ALERT_BIT.PARTNER_LIQUIDITY_LOW |
          ALERT_BIT.BRIDGE_LAG_SLA_BREACH |
          ALERT_BIT.CHURN_DECILE_SPIKE,
      ),
    );
  });
});

describe("threshold alert loop", () => {
  test("an overlapping tick is busy and a later tick evaluates again", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, state } = createMemoryStore();
    const { send, texts } = recordingSender();
    let collects = 0;
    const loop = createThresholdAlertLoop({
      intervalMs: 1_000,
      collect: async () => {
        collects += 1;
        await gate;
        return breachReadings();
      },
      policy: POLICY,
      store,
      send,
    });

    const first = loop.tickOnce();
    const busy = await loop.tickOnce();
    expect(busy).toEqual({ status: "busy" });
    expect(collects).toBe(1);
    release();
    expect(completedResult(await first).delivery).toEqual({ status: "sent" });

    const later = completedResult(await loop.tickOnce());
    expect(collects).toBe(2);
    expect(later.delivery).toEqual({ status: "skipped" });
    expect(texts).toHaveLength(1);
    expect(state.writes).toHaveLength(1);
  });

  test("stop() during an in-flight tick lets it finish and prevents more ticks", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let collects = 0;
    let sends = 0;
    const loop = createThresholdAlertLoop({
      intervalMs: 5,
      collect: async () => {
        collects += 1;
        await gate;
        return breachReadings();
      },
      policy: POLICY,
      store: createMemoryStore().store,
      send: async () => {
        sends += 1;
        return { ok: true };
      },
    });

    loop.start();
    await waitFor(() => collects >= 1);
    loop.stop();
    loop.stop();
    release();
    await Bun.sleep(25);
    const collectsAfterStop = collects;
    expect(collectsAfterStop).toBe(1);
    expect(sends).toBe(1);

    // A restart after the in-flight tick drained schedules fresh work.
    loop.start();
    await waitFor(() => collects >= 2);
    loop.stop();
    expect(collects).toBe(2);
  });

  test("start() unrefs one interval, is idempotent, and stop() clears it", () => {
    const { spy, restore } = spyIntervals();
    try {
      const loop = createThresholdAlertLoop({
        intervalMs: 60_000,
        collect: async () => healthyReadings(),
        policy: POLICY,
        store: createMemoryStore().store,
        send: async () => ({ ok: true }),
      });
      loop.start();
      loop.start();
      expect(spy.delays).toEqual([60_000]);
      expect(spy.unrefs).toBe(1);
      loop.stop();
      loop.stop();
      expect(spy.cleared).toBe(1);

      loop.start();
      expect(spy.delays).toHaveLength(2);
      expect(spy.unrefs).toBe(2);
      loop.stop();
      expect(spy.cleared).toBe(2);
    } finally {
      restore();
    }
  });

  test("rejects non-positive and non-finite intervals", () => {
    for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createThresholdAlertLoop({
          intervalMs,
          collect: async () => healthyReadings(),
          policy: POLICY,
          store: createMemoryStore().store,
          send: async () => ({ ok: true }),
        }),
      ).toThrow(RangeError);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Console live runtimes                                                      */
/* -------------------------------------------------------------------------- */

const CONSOLE_BASE = {
  cwd: REPO_ROOT,
  publishTick: () => undefined,
  bridgeLagMs: () => null,
} as const;

describe("console live runtimes", () => {
  test("starts nothing and creates no timer when both flags are absent", () => {
    const { spy, restore } = spyIntervals();
    try {
      const runtimes = startConsoleLiveRuntimes({ ...CONSOLE_BASE, env: {} });
      expect(runtimes.started).toEqual([]);
      expect(runtimes.skipped).toEqual([
        "wager-telemetry:disabled",
        "threshold-alerts:disabled",
      ]);
      expect(spy.delays).toEqual([]);
      expect(spy.unrefs).toBe(0);
      runtimes.stop();
      runtimes.stop();
      expect(spy.cleared).toBe(0);
    } finally {
      restore();
    }
  });

  test("accepts only the documented truthy flag spellings", () => {
    const truthy = ["on", "1", "true", "yes", " ON ", " True "];
    for (const value of truthy) {
      const { spy, restore } = spyIntervals();
      try {
        const runtimes = startConsoleLiveRuntimes({
          ...CONSOLE_BASE,
          env: { SPORTSDESK_WAGER_TELEMETRY: value },
          readLiveWagerRows: async () => [],
        });
        expect(runtimes.started).toEqual(["wager-telemetry"]);
        expect(spy.delays).toEqual([5_000]);
        expect(spy.unrefs).toBe(1);
        runtimes.stop();
        expect(spy.cleared).toBe(1);
      } finally {
        restore();
      }
    }

    const falsey = ["off", "0", "no", "false", "disabled", "", " "];
    for (const value of falsey) {
      const { spy, restore } = spyIntervals();
      try {
        const runtimes = startConsoleLiveRuntimes({
          ...CONSOLE_BASE,
          env: { SPORTSDESK_WAGER_TELEMETRY: value },
          readLiveWagerRows: async () => [],
        });
        expect(runtimes.started).toEqual([]);
        expect(runtimes.skipped).toContain("wager-telemetry:disabled");
        expect(spy.delays).toEqual([]);
        runtimes.stop();
      } finally {
        restore();
      }
    }
  });

  test("publishes the captured sample's two mapped ticks, then stop halts polling", async () => {
    const rows = await loadFixtureRows("live-wagers-list-sample.json");
    const ticks: WagerTickInput[] = [];
    const runtimes = startConsoleLiveRuntimes({
      ...CONSOLE_BASE,
      env: {
        SPORTSDESK_WAGER_TELEMETRY: "on",
        SPORTSDESK_WAGER_TELEMETRY_INTERVAL_MS: "60000",
      },
      publishTick: (tick) => ticks.push(tick),
      readLiveWagerRows: async () => rows,
    });

    expect(runtimes.started).toEqual(["wager-telemetry"]);
    await waitFor(() => ticks.length === 2);
    expect(ticks.map((tick) => tick.wagerId)).toEqual([
      767_126_203n,
      767_126_258n,
    ]);
    expect(ticks.map((tick) => tick.lineHundredths)).toEqual([
      asLineHundredths(4_650),
      asLineHundredths(-200),
    ]);
    expect(ticks.map((tick) => tick.routeWord32)).toEqual([
      GSLIVE_BRIDGE_ROUTE_WORD32,
      F402_BRIDGE_ROUTE_WORD32,
    ]);

    runtimes.stop();
    await Bun.sleep(25);
    expect(ticks).toHaveLength(2);
  });

  test("a poll that resolves after stop never publishes its late tick", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readStarted = false;
    const ticks: WagerTickInput[] = [];
    const runtimes = startConsoleLiveRuntimes({
      ...CONSOLE_BASE,
      env: {
        SPORTSDESK_WAGER_TELEMETRY: "on",
        SPORTSDESK_WAGER_TELEMETRY_INTERVAL_MS: "60000",
      },
      publishTick: (tick) => ticks.push(tick),
      readLiveWagerRows: async () => {
        readStarted = true;
        await gate;
        return [liveRow() as unknown as Record<string, unknown>];
      },
    });

    await waitFor(() => readStarted);
    runtimes.stop();
    release();
    await Bun.sleep(25);
    expect(ticks).toEqual([]);
  });

  test("skips threshold alerts when Telegram is absent or blank", async () => {
    const cases: readonly Record<string, string>[] = [
      { SPORTSDESK_THRESHOLD_ALERTS: "on" },
      { SPORTSDESK_THRESHOLD_ALERTS: "on", TELEGRAM_BOT_TOKEN: "token" },
      { SPORTSDESK_THRESHOLD_ALERTS: "on", TELEGRAM_CHAT_ID: "42" },
      {
        SPORTSDESK_THRESHOLD_ALERTS: "on",
        TELEGRAM_BOT_TOKEN: "  ",
        TELEGRAM_CHAT_ID: "42",
      },
      {
        SPORTSDESK_THRESHOLD_ALERTS: "on",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: " ",
      },
    ];
    for (const env of cases) {
      const runtimes = startConsoleLiveRuntimes({ ...CONSOLE_BASE, env });
      expect(runtimes.started).toEqual([]);
      expect(runtimes.skipped).toContain(
        "threshold-alerts:telegram_not_configured",
      );
      runtimes.stop();
    }
  });

  test("a bridge lag exactly at the SLA is inside policy and writes no state", async () => {
    const dir = await makeTempDir();
    const statePath = join(dir, "state.json");
    const runtimes = startConsoleLiveRuntimes({
      ...CONSOLE_BASE,
      bridgeLagMs: () => 1_000,
      env: {
        SPORTSDESK_THRESHOLD_ALERTS: "on",
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_CHAT_ID: "test-chat",
        SPORTSDESK_BRIDGE_LAG_SLA_MS: "1000",
        SPORTSDESK_THRESHOLD_STATE_PATH: statePath,
        SPORTSDESK_THRESHOLD_INTERVAL_MS: "60000",
      },
    });

    expect(runtimes.started).toEqual(["threshold-alerts"]);
    await Bun.sleep(25);
    expect(existsSync(statePath)).toBe(false);
    runtimes.stop();
  });

  test("clamps the configured intervals to their documented bounds", () => {
    const low = spyIntervals();
    try {
      const runtimes = startConsoleLiveRuntimes({
        ...CONSOLE_BASE,
        env: {
          SPORTSDESK_WAGER_TELEMETRY: "on",
          SPORTSDESK_WAGER_TELEMETRY_INTERVAL_MS: "5",
        },
        readLiveWagerRows: async () => [],
      });
      expect(low.spy.delays).toEqual([1_000]);
      runtimes.stop();
    } finally {
      low.restore();
    }

    const high = spyIntervals();
    try {
      const runtimes = startConsoleLiveRuntimes({
        ...CONSOLE_BASE,
        env: {
          SPORTSDESK_WAGER_TELEMETRY: "on",
          SPORTSDESK_WAGER_TELEMETRY_INTERVAL_MS: "999999",
        },
        readLiveWagerRows: async () => [],
      });
      expect(high.spy.delays).toEqual([60_000]);
      runtimes.stop();
    } finally {
      high.restore();
    }

    const both = spyIntervals();
    try {
      const runtimes = startConsoleLiveRuntimes({
        ...CONSOLE_BASE,
        env: {
          SPORTSDESK_WAGER_TELEMETRY: "on",
          SPORTSDESK_THRESHOLD_ALERTS: "on",
          TELEGRAM_BOT_TOKEN: "test-token",
          TELEGRAM_CHAT_ID: "test-chat",
          SPORTSDESK_THRESHOLD_STATE_PATH: join(
            tmpdir(),
            `console-live-clamp-${process.pid}-${Date.now()}.json`,
          ),
          SPORTSDESK_THRESHOLD_INTERVAL_MS: "5",
        },
        readLiveWagerRows: async () => [],
      });
      expect(both.spy.delays).toEqual([5_000, 1_000]);
      expect(both.spy.unrefs).toBe(2);
      runtimes.stop();
      expect(both.spy.cleared).toBe(2);
    } finally {
      both.restore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* startServer hook                                                           */
/* -------------------------------------------------------------------------- */

describe("startServer console hook", () => {
  test("adds no console timers with both flags off and stop still resolves", async () => {
    await withEnv(
      {
        SPORTSDESK_WAGER_TELEMETRY: undefined,
        SPORTSDESK_THRESHOLD_ALERTS: undefined,
      },
      async () => {
        const { spy, restore } = spyIntervals();
        try {
          const server = startServer({ port: 0, hostname: "127.0.0.1" });
          expect(spy.delays).toEqual([]);
          expect(spy.unrefs).toBe(0);
          expect(typeof server.stop).toBe("function");
          await server.stop(true);
          expect(spy.cleared).toBe(0);
        } finally {
          restore();
          stopBridgeHub();
        }
      },
    );
  });

  test("starts two unref'd timers when both flags are on and stop clears them", async () => {
    const dir = await makeTempDir();
    const statePath = join(dir, "threshold-state.json");
    await withEnv(
      {
        SPORTSDESK_WAGER_TELEMETRY: "on",
        SPORTSDESK_WAGER_TELEMETRY_INTERVAL_MS: "60000",
        SPORTSDESK_THRESHOLD_ALERTS: "on",
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_CHAT_ID: "test-chat",
        SPORTSDESK_THRESHOLD_STATE_PATH: statePath,
        SPORTSDESK_THRESHOLD_INTERVAL_MS: "60000",
      },
      async () => {
        const { spy, restore } = spyIntervals();
        try {
          const server = startServer({ port: 0, hostname: "127.0.0.1" });
          expect(spy.delays).toEqual([60_000, 60_000]);
          expect(spy.unrefs).toBe(2);
          await server.stop(true);
          expect(spy.cleared).toBe(2);
          // The composed stop stays idempotent (attachMcpServerStop still runs first).
          await server.stop(true);
          expect(spy.cleared).toBe(2);
          expect(existsSync(statePath)).toBe(false);
        } finally {
          restore();
          stopBridgeHub();
        }
      },
    );
  });

  test("publishWagerTick accepts a producer-mapped live row", async () => {
    const rows = await loadFixtureRows("live-wagers-list-sample.json");
    const row = rows.find((candidate) => candidate.WagerNumber === 767_126_203);
    if (row === undefined) throw new Error("expected the captured total row");
    const tick = expectTick(row as unknown as LiveWagerRow);

    const result = publishWagerTick(tick);
    expect(result.clients).toBeGreaterThanOrEqual(0);
    expect(result.delivered).toBe(
      result.clients -
        result.skippedByBridgeMask -
        result.backpressured -
        result.dropped,
    );
  });
});
