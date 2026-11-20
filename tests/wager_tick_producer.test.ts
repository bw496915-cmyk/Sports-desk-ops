/**
 * @file tests/wager_tick_producer.test.ts
 * @description Contract tests for the live wager-tick producer: the bare line parser, the
 * row -> `WagerTickInput` mapping (bridge, channel, stake, id, UTC-5 wall clock), and the
 * polling loop's per-poll counts and `WagerNumber` dedupe.
 */

import { describe, expect, test } from "bun:test";
import type { BridgeChannelPackedWord32 } from "../design/domain-branded-types.ts";
import {
  asCents,
  asLineHundredths,
  encodeBridgeChannelPackedWord32,
} from "../lib/bridge_and_channel_router.ts";
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

/** Contract-derived expected words: P118 tally bridge 3 / GSLIVE channel 5, F402 bridge 2 / LIVE_CWS 7. */
const GSLIVE_ROUTE = encodeBridgeChannelPackedWord32(
  "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
  "GSLIVE",
);
const F402_ROUTE = encodeBridgeChannelPackedWord32(
  "BRIDGE_02_F402_PENDING_AND_GRADING",
  "LIVE_CWS",
);

/** `2026-11-19 18:20:02.280` at UTC-5 is `2026-11-19T23:20:02.280Z`. */
const INSERT_DATE_TIME = "2026-11-19 18:20:02.280";
const WALL_EPOCH_MS = asWallEpochMs(Date.UTC(2026, 10, 19, 23, 20, 2, 280));

function liveRow(overrides: Partial<LiveWagerRow> = {}): LiveWagerRow {
  return {
    WagerNumber: 769_484_623,
    TicketWriter: "Internet",
    AmountWagered: 10_000,
    InsertDateTime: INSERT_DATE_TIME,
    ShortDesc: "-3.5",
    ...overrides,
  };
}

function expectTick(row: LiveWagerRow): WagerTickInput {
  const tick = wagerRowToTick(row);
  if (tick === null) throw new Error("expected the row to map to a tick");
  return tick;
}

describe("parseTickLineHundredths", () => {
  const lineCases: readonly (readonly [string, number])[] = [
    ["+3.5", 350],
    ["-3.5", -350],
    ["3.5", 350],
    ["+17.5", 1_750],
    ["-7", -700],
    ["0", 0],
    ["PK", 0],
    ["pk", 0],
    ["Over 143.5", 14_350],
    ["Under 143.5", 14_350],
    ["O 44", 4_400],
    ["U 6", 600],
    // Real live-wagers.json grammars: the line sits immediately before the price.
    ["S.Football #312 Texans -12½ -110 - For Game", -1_250],
    ["L:Basketball #503 Knicks/Timberwolves O 112 -110 - For 1st Half", 11_200],
    ["S.Basketball #761 Texas A&M PK -110 - For Game", 0],
    ["David Montgomery Over 39.5 -312", 3_950],
    ["Over 0.5 -136", 50],
    ["O 112 -110 - For 1st Half", 11_200],
    ["Over 3&#xBD;", 350],
    ["-1&#xBD;", -150],
    [
      "Football - Auburn vs Alabama / Game / Point spread / Auburn +3.5 -163",
      350,
    ],
  ];

  for (const [shortDesc, hundredths] of lineCases) {
    test(`parses ${JSON.stringify(shortDesc)} as ${hundredths} hundredths`, () => {
      expect(parseTickLineHundredths(shortDesc)).toBe(
        asLineHundredths(hundredths),
      );
    });
  }

  test("normalizes CR/LF, entity artefacts and half-point entities", () => {
    expect(parseTickLineHundredths("-3.5\r\n")).toBe(asLineHundredths(-350));
    expect(parseTickLineHundredths("  +3.5 ")).toBe(asLineHundredths(350));
    expect(parseTickLineHundredths("Over 143.5&#x0D;")).toBe(
      asLineHundredths(14_350),
    );
    expect(parseTickLineHundredths("-3.5&#x0D;&#x0D;")).toBe(
      asLineHundredths(-350),
    );
    expect(parseTickLineHundredths("-1&#189;")).toBe(asLineHundredths(-150));
    expect(parseTickLineHundredths("+17&#189;")).toBe(asLineHundredths(1_750));
    expect(parseTickLineHundredths("-1½")).toBe(asLineHundredths(-150));
    expect(parseTickLineHundredths("Over&nbsp;143.5")).toBe(
      asLineHundredths(14_350),
    );
    expect(parseTickLineHundredths("<b>Over 143.5</b>")).toBe(
      asLineHundredths(14_350),
    );
  });

  test("returns null for moneyline, odds-only, parlay and absent lines", () => {
    const noLineCases: readonly string[] = [
      "",
      "   ",
      "\r\n",
      "G Knights -125 - For Game",
      "Hockey #52 G Knights -125 - For Game",
      "M.Hockey #47 Ducks +110 - For Game",
      "Tyler Warren 1st Touchdown +600",
      "Tyler Warren +2000 for Game",
      "Over 143.5 points",
      // Two priced legs have no single line to report.
      "S.Football #1 Americans -3.5 -110 / S.Football #2 Nationals +4.5 -105",
      // Equal-magnitude legs are still two lines, not one deduped value.
      "P.Hockey #39 Kings +1½ -225 - For Game Hockey #31 Flyers +1½ -175 - For Game",
      // A value past int32 cannot be packed into the frame.
      "Over 21474836.48",
      // A bare American price is odds, not a 140-point spread.
      "-140",
      "+600",
      // Sub-hundredth precision is not representable.
      "3.141",
      "3.",
      "+",
      "Push",
    ];
    for (const shortDesc of noLineCases) {
      expect(parseTickLineHundredths(shortDesc)).toBeNull();
    }
  });

  test("PK is an exact push, not -0", () => {
    expect(parseTickLineHundredths("PK")).toBe(asLineHundredths(0));
    expect(Object.is(parseTickLineHundredths("PK"), -0)).toBe(false);
  });
});

describe("wagerRowToTick", () => {
  test("routes a GSLIVE writer to the Partner118 tally bridge on GSLIVE", () => {
    const tick = expectTick(liveRow({ TicketWriter: " GSLIVE  " }));
    expect(tick.routeWord32).toBe(GSLIVE_ROUTE);
    expect(tick.routeWord32).toBe(GSLIVE_BRIDGE_ROUTE_WORD32);
    expect(tick.routeWord32).not.toBe(F402_ROUTE);
  });

  test("routes by the trimmed, uppercased writer prefix", () => {
    const writerCases: readonly (readonly [
      string,
      BridgeChannelPackedWord32,
    ])[] = [
      ["Internet", F402_ROUTE],
      ["ALERT", F402_ROUTE],
      ["GSBUILDER", F402_ROUTE],
      ["gslive", GSLIVE_ROUTE],
      [" Gslive ", GSLIVE_ROUTE],
    ];
    for (const [writer, expected] of writerCases) {
      expect(expectTick(liveRow({ TicketWriter: writer })).routeWord32).toBe(
        expected,
      );
    }
  });

  test("reads the portal wall clock as UTC-5", () => {
    const tick = expectTick(liveRow());
    expect(tick.wallEpochMs).toBe(WALL_EPOCH_MS);
    expect(new Date(tick.wallEpochMs).toISOString()).toBe(
      "2026-11-19T23:20:02.280Z",
    );
  });

  test("maps stake cents, wager id and signed line", () => {
    const tick = expectTick(liveRow());
    expect(tick.stakeCents).toBe(asCents(10_000));
    expect(tick.wagerId).toBe(769_484_623n);
    expect(tick.lineHundredths).toBe(asLineHundredths(-350));
  });

  test("accepts a zero stake and a total line magnitude", () => {
    const tick = expectTick(
      liveRow({ AmountWagered: 0, ShortDesc: "Over 143.5" }),
    );
    expect(tick.stakeCents).toBe(asCents(0));
    expect(tick.lineHundredths).toBe(asLineHundredths(14_350));
  });

  test("returns null when the description carries no line", () => {
    expect(wagerRowToTick(liveRow({ ShortDesc: "G Knights -125" }))).toBeNull();
    expect(wagerRowToTick(liveRow({ ShortDesc: undefined }))).toBeNull();
    expect(wagerRowToTick(liveRow({ ShortDesc: 42 }))).toBeNull();
  });

  const invalidRows: readonly (readonly [string, LiveWagerRow])[] = [
    ["negative stake", liveRow({ AmountWagered: -1 })],
    ["fractional stake", liveRow({ AmountWagered: 1.5 })],
    ["stake above int32", liveRow({ AmountWagered: 2 ** 31 })],
    ["fractional wager number", liveRow({ WagerNumber: 1.5 })],
    [
      "unsafe wager number",
      liveRow({ WagerNumber: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["negative wager number", liveRow({ WagerNumber: -1 })],
    ["numeric-string wager number", liveRow({ WagerNumber: "769484623" })],
    ["non-string writer", liveRow({ TicketWriter: 42 })],
    ["missing writer", liveRow({ TicketWriter: undefined })],
    ["missing timestamp", liveRow({ InsertDateTime: undefined })],
    ["unparseable timestamp", liveRow({ InsertDateTime: "not-a-date" })],
    [
      "impossible calendar date",
      liveRow({ InsertDateTime: "2026-02-30 12:00:00.000" }),
    ],
    [
      "wall clock with a zone",
      liveRow({ InsertDateTime: `${INSERT_DATE_TIME}Z` }),
    ],
  ];

  for (const [label, row] of invalidRows) {
    test(`returns null for an invalid row: ${label}`, () => {
      expect(wagerRowToTick(row)).toBeNull();
    });
  }

  test("returns null for a null row rather than throwing", () => {
    expect(wagerRowToTick(null as unknown as LiveWagerRow)).toBeNull();
  });
});

describe("createWagerTickProducer", () => {
  const gsliveRow = liveRow({
    WagerNumber: 101,
    TicketWriter: "GSLIVE",
    ShortDesc: "+3.5",
  });
  const internetRow = liveRow({
    WagerNumber: 102,
    TicketWriter: "Internet",
    ShortDesc: "Over 143.5",
  });
  const moneylineRow = liveRow({
    WagerNumber: 103,
    ShortDesc: "G Knights -125 - For Game",
  });
  const invalidRow = liveRow({ WagerNumber: 104, AmountWagered: -1 });

  test("publishes mapped ticks once and reports per-poll counts", async () => {
    const published: WagerTickInput[] = [];
    const rows: readonly LiveWagerRow[] = [
      gsliveRow,
      internetRow,
      moneylineRow,
      invalidRow,
    ];
    const producer = createWagerTickProducer({
      readRows: async () => rows,
      publish: (tick) => {
        published.push(tick);
        return published.length;
      },
      now: () => 1_700_000_000_000,
    });

    expect(await producer.pollOnce()).toEqual({
      read: 4,
      published: 2,
      skippedNoLine: 1,
      skippedInvalid: 1,
    });
    expect(published.map((tick) => tick.wagerId)).toEqual([101n, 102n]);
    expect(published.map((tick) => tick.routeWord32)).toEqual([
      GSLIVE_ROUTE,
      F402_ROUTE,
    ]);
  });

  test("dedupes by WagerNumber across two polls", async () => {
    const published: WagerTickInput[] = [];
    const firstPoll: readonly LiveWagerRow[] = [gsliveRow, internetRow];
    const secondPoll: readonly LiveWagerRow[] = [
      gsliveRow,
      internetRow,
      liveRow({ WagerNumber: 105, ShortDesc: "-7" }),
    ];
    let poll = 0;
    const producer = createWagerTickProducer({
      readRows: async () => (poll++ === 0 ? firstPoll : secondPoll),
      publish: (tick) => published.push(tick),
      now: () => 1_700_000_000_000,
    });

    expect(await producer.pollOnce()).toEqual({
      read: 2,
      published: 2,
      skippedNoLine: 0,
      skippedInvalid: 0,
    });
    expect(await producer.pollOnce()).toEqual({
      read: 3,
      published: 1,
      skippedNoLine: 0,
      skippedInvalid: 0,
    });
    expect(published.map((tick) => tick.wagerId)).toEqual([101n, 102n, 105n]);
  });

  test("publishes a repeated WagerNumber only once within one poll", async () => {
    const published: WagerTickInput[] = [];
    const producer = createWagerTickProducer({
      readRows: async () => [gsliveRow, gsliveRow],
      publish: (tick) => published.push(tick),
      now: () => 1,
    });

    expect(await producer.pollOnce()).toEqual({
      read: 2,
      published: 1,
      skippedNoLine: 0,
      skippedInvalid: 0,
    });
    expect(published).toHaveLength(1);
  });

  test("skips malformed rows without throwing", async () => {
    const published: WagerTickInput[] = [];
    const rows = [
      null as unknown as LiveWagerRow,
      {},
      liveRow({ WagerNumber: "102" }),
      liveRow({ InsertDateTime: "yesterday" }),
    ];
    const producer = createWagerTickProducer({
      readRows: async () => rows,
      publish: (tick) => published.push(tick),
      now: () => 1,
    });

    expect(await producer.pollOnce()).toEqual({
      read: 4,
      published: 0,
      skippedNoLine: 0,
      skippedInvalid: 4,
    });
    expect(published).toHaveLength(0);
  });

  test("handles an empty source without publishing", async () => {
    let publishCalls = 0;
    const producer = createWagerTickProducer({
      readRows: async () => [],
      publish: () => {
        publishCalls++;
      },
      now: () => 1_700_000_000_000,
    });

    expect(await producer.pollOnce()).toEqual({
      read: 0,
      published: 0,
      skippedNoLine: 0,
      skippedInvalid: 0,
    });
    expect(publishCalls).toBe(0);
  });

  test("records the poll start time from the injected clock", async () => {
    let clock = 1_700_000_000_123;
    const producer = createWagerTickProducer({
      readRows: async () => {
        clock += 500;
        return [];
      },
      publish: () => undefined,
      now: () => clock,
    });

    expect(producer.lastPollAtEpochMs).toBeNull();
    await producer.pollOnce();
    expect(producer.lastPollAtEpochMs).toBe(1_700_000_000_123);
  });

  test("falls back to the wall clock when no clock is injected", async () => {
    const before = Date.now();
    const producer = createWagerTickProducer({
      readRows: async () => [],
      publish: () => undefined,
    });

    await producer.pollOnce();
    const polledAt = producer.lastPollAtEpochMs;
    if (polledAt === null) throw new Error("expected a poll time");
    expect(polledAt).toBeGreaterThanOrEqual(before);
    expect(polledAt).toBeLessThanOrEqual(Date.now());
  });
});
