import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildAddressProfile,
  fetchProfileActivity,
  inferCategory,
  profilePolymarketAddress,
  resolvePolymarketAddress,
  summarizeActivity,
} from "../lib/polymarket_profile.ts";

const ADDRESS = "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612";
const EVENT_ADDRESS = `0x${"1".repeat(40)}`;

function position(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    proxyWallet: ADDRESS,
    asset: "asset",
    conditionId: "0xcond",
    size: 100,
    avgPrice: 0.5,
    initialValue: 50,
    currentValue: 0,
    cashPnl: 0,
    curPrice: 0.5,
    redeemable: false,
    title: "Market",
    slug: "slug",
    eventId: "1",
    outcome: "Yes",
    endDate: null,
    ...overrides,
  };
}

const POSITIONS = [
  position({
    asset: "open1",
    slug: "s1",
    title: "NBA Finals",
    currentValue: 100,
    initialValue: 50,
  }),
  position({
    asset: "open2",
    slug: "s2",
    title: "NBA MVP",
    currentValue: 50,
    initialValue: 50,
  }),
  position({
    asset: "win1",
    slug: "w1",
    title: "Win one",
    redeemable: true,
    currentValue: 30,
    cashPnl: 30,
  }),
  position({
    asset: "win2",
    slug: "w2",
    title: "Win two",
    redeemable: true,
    currentValue: 20,
    cashPnl: 20,
  }),
  position({
    asset: "loss1",
    slug: "l1",
    title: "Loss",
    redeemable: true,
    currentValue: 0,
    cashPnl: -20,
  }),
  position({
    asset: "loss2",
    slug: "l2",
    title: "Loss two",
    redeemable: true,
    currentValue: 0,
    cashPnl: -10,
  }),
];

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/v2/leaderboard")) {
        const user = url.searchParams.get("user");
        if (user !== null) {
          const period = url.searchParams.get("time_period") ?? "day";
          const pnl = period === "all" ? 1200 : 100;
          return Response.json({
            data: { user_id: user, pnl, user_name: "AF12" },
          });
        }
        return Response.json({
          data: [{ user_name: "AF12", user_id: ADDRESS }],
          pagination: { next_cursor: "" },
        });
      }
      if (url.pathname.endsWith("/profit")) {
        const address = url.searchParams.get("address");
        if (address !== null) {
          return Response.json([
            {
              amount: url.searchParams.get("window") === "all" ? 1200 : 100,
              name: "AF12",
            },
          ]);
        }
        return Response.json([
          { name: "AF12", pseudonym: "af12", proxyWallet: ADDRESS },
        ]);
      }
      if (url.pathname.endsWith("/positions")) return Response.json(POSITIONS);
      if (url.pathname.endsWith("/activity")) {
        if (url.searchParams.get("user") === EVENT_ADDRESS) {
          return Response.json([
            {
              type: "TRADE",
              slug: "",
              eventSlug: "evt-x",
              conditionId: "0xc",
              usdcSize: 1,
              side: "BUY",
              timestamp: 1,
              title: "A",
              outcome: "Yes",
            },
          ]);
        }
        const end = url.searchParams.get("end");
        if (end === null) {
          const rows = Array.from({ length: 500 }, (_, index) => ({
            type: "TRADE",
            slug: `m${index}`,
            usdcSize: 10,
            side: "BUY",
            timestamp: 1000 - index,
            title: `Trade ${index}`,
            outcome: "Yes",
          }));
          return Response.json(rows);
        }
        return Response.json([
          {
            type: "REDEEM",
            slug: "m0",
            usdcSize: 20,
            side: "",
            timestamp: 500,
            title: "Redeem",
            outcome: "Yes",
          },
          {
            type: "REDEEM",
            slug: "m1",
            usdcSize: 10,
            side: "",
            timestamp: 499,
            title: "Redeem",
            outcome: "Yes",
          },
        ]);
      }
      if (url.pathname.endsWith("/events")) {
        return Response.json([
          { category: "Sports", tags: [{ label: "NBA" }] },
        ]);
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("Polymarket profile", () => {
  test("resolves an address or a leaderboard username", async () => {
    expect(await resolvePolymarketAddress(ADDRESS, { dataBase: base })).toBe(
      ADDRESS.toLowerCase(),
    );
    expect(await resolvePolymarketAddress("af12", { dataBase: base })).toBe(
      ADDRESS.toLowerCase(),
    );
    expect(
      await resolvePolymarketAddress("missing-user", { dataBase: base }),
    ).toBeNull();
  });

  test("paginates activity by the last timestamp", async () => {
    const result = await fetchProfileActivity(ADDRESS, {
      dataBase: base,
      sleepMs: 0,
      maxActivityPages: 5,
    });
    expect(result.pages).toBe(2);
    expect(result.rows).toHaveLength(502);
    expect(result.truncated).toBe(false);
  });

  test("falls back to eventSlug/conditionId when activity slug is empty", async () => {
    const result = await fetchProfileActivity(EVENT_ADDRESS, {
      dataBase: base,
      sleepMs: 0,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.slug).toBe("evt-x");
  });

  test("summarizes activity types", () => {
    const summary = summarizeActivity([
      {
        type: "TRADE",
        slug: "a",
        usdcSize: 10,
        side: "BUY",
        timestamp: 1,
        title: "A",
        outcome: "Yes",
      },
      {
        type: "TRADE",
        slug: "b",
        usdcSize: 5,
        side: "SELL",
        timestamp: 2,
        title: "B",
        outcome: "Yes",
      },
      {
        type: "SPLIT",
        slug: "c",
        usdcSize: 7,
        side: "",
        timestamp: 3,
        title: "C",
        outcome: "Yes",
      },
      {
        type: "MERGE",
        slug: "c",
        usdcSize: 3,
        side: "",
        timestamp: 4,
        title: "C",
        outcome: "Yes",
      },
      {
        type: "REDEEM",
        slug: "d",
        usdcSize: 9,
        side: "",
        timestamp: 5,
        title: "D",
        outcome: "Yes",
      },
    ]);
    expect(summary).toMatchObject({
      tradeBuys: 1,
      tradeSells: 1,
      tradeVolume: 15,
      splitVolume: 7,
      mergeVolume: 3,
      redeemVolume: 9,
      uniqueMarkets: 4,
    });
  });

  test("maps categories from Gamma tags and title keywords", () => {
    expect(inferCategory("Sports", ["NBA"], "Anything")).toBe("Sports");
    expect(inferCategory("", [], "Will Bitcoin hit $200k?")).toBe("Crypto");
    expect(inferCategory("", [], "Will Trump win the election?")).toBe(
      "Politics",
    );
    expect(inferCategory("", [], "Will it rain in NYC?")).toBe("Weather");
    expect(inferCategory("", [], "Unknown market")).toBe("Other");
  });

  test("builds a profile end to end", async () => {
    const profile = await profilePolymarketAddress(ADDRESS, {
      dataBase: base,
      gammaBase: base,
      sleepMs: 0,
      maxActivityPages: 5,
    });
    expect(profile).not.toBeNull();
    if (profile === null) return;

    expect(profile.address).toBe(ADDRESS.toLowerCase());
    expect(profile.pnl.all).toBe(1200);
    expect(profile.pnl.d7).toBe(100);
    expect(profile.pnl.d30).toBe(100);
    expect(profile.pnlAudit.lbApiPnlUsd).toBe(1200);
    expect(profile.pnlAudit.gapUsd).not.toBeNull();
    expect(profile.wins).toBe(2);
    expect(profile.losses).toBe(2);
    expect(profile.winRate).toBe(50);
    expect(profile.winRateEstimated).toBe(false);
    expect(profile.openCount).toBe(2);
    expect(profile.portfolioValueUsd).toBe(150);
    expect(profile.investedUsd).toBe(300);
    expect(profile.categories[0]).toMatchObject({
      category: "Sports",
      positions: 2,
      valueUsd: 150,
      sharePct: 100,
    });
    expect(profile.activity.tradeBuys).toBe(500);
    expect(profile.activity.redeemVolume).toBe(30);
    expect(profile.pagesFetched).toBe(2);
    expect(profile.strategy.name).toBe("Diversified");
    expect(profile.topWins[0]?.cashPnl).toBe(30);
    expect(profile.topLosses[0]?.cashPnl).toBe(-20);
  });

  test("falls back to activity when settled positions are sparse", () => {
    const profile = buildAddressProfile({
      address: ADDRESS,
      pnl: { all: 0, d7: null, d30: null, name: null },
      positions: [],
      activity: [
        {
          type: "TRADE",
          slug: "a",
          usdcSize: 10,
          side: "BUY",
          timestamp: 1,
          title: "A",
          outcome: "Yes",
        },
        {
          type: "REDEEM",
          slug: "a",
          usdcSize: 20,
          side: "",
          timestamp: 2,
          title: "A",
          outcome: "Yes",
        },
      ],
      categories: new Map(),
      pagesFetched: 1,
      activityTruncated: false,
    });
    expect(profile.winRateEstimated).toBe(true);
    expect(profile.wins).toBe(1);
    expect(profile.losses).toBe(0);
  });
});
