import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  extractComboLegs,
  fetchCfbComboEvents,
  normalizeComboActivity,
  normalizeComboPosition,
  parsePriceList,
  parseStringArray,
  priceCombo,
  resolveLegSpecs,
  summarizeComboWallet,
} from "../lib/polymarket_combo.ts";

const WALLET = "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612";
const EVENT = {
  id: "1",
  slug: "cfb-a-b-2026-10-31",
  title: "A vs. B",
  startTime: "2026-10-31T16:00:00Z",
  markets: [
    {
      slug: "cfb-a-b-ml",
      question: "A vs. B",
      sportsMarketType: "moneyline",
      outcomes: '["A", "B"]',
      outcomePrices: '["0.38", "0.62"]',
    },
    {
      slug: "cfb-a-b-spread",
      question: "A vs. B spread",
      sportsMarketType: "spreads",
      line: -3.5,
      outcomes: '["A -3.5", "B +3.5"]',
      outcomePrices: '["0.55", "0.45"]',
    },
    {
      slug: "cfb-a-b-total",
      question: "A vs. B total",
      sportsMarketType: "totals",
      outcomes: '["Over 50.5", "Under 50.5"]',
      outcomePrices: '["0.5", "0.5"]',
    },
    {
      slug: "cfb-a-b-1h",
      question: "A vs. B 1H",
      sportsMarketType: "first_half",
      outcomes: '["A", "B"]',
      outcomePrices: '["0.5", "0.5"]',
    },
    {
      slug: "cfb-a-b-dead",
      question: "Settled",
      sportsMarketType: "moneyline",
      outcomes: '["C", "D"]',
      outcomePrices: '["1", "0"]',
    },
  ],
};

const POSITION = {
  combo_condition_id: "0xcombo",
  combo_position_id: "pos-1",
  proxy_wallet: WALLET,
  outcome_label: "Yes",
  current_size: 100,
  entry_avg_price_usdc: 0.3,
  entry_cost_usdc: 30,
  status: "OPEN",
  redeemable: false,
  legs_total: 2,
  legs_resolved: 0,
  legs_pending: 2,
  first_entry_at: "2026-10-31T20:00:00Z",
  legs: [
    {
      leg_index: 0,
      leg_condition_id: "0xleg",
      leg_outcome_label: "LOS",
      leg_status: "OPEN",
      leg_current_price: 0.695,
      market: {
        slug: "lol-los-ly",
        sports_market_type: "moneyline",
        line: null,
        outcome: "LOS",
      },
    },
  ],
};

const ACTIVITY = {
  id: "tx-1",
  type: "SPLIT",
  proxy_wallet: WALLET,
  amount_usdc: 30,
  payout_usdc: null,
  timestamp: 1793482272,
  combo_condition_id: "0xcombo",
  legs: POSITION.legs,
};

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/events")) return Response.json([EVENT]);
      if (url.pathname.endsWith("/v2/positions/combos")) {
        return Response.json({
          data: [POSITION],
          pagination: { next_cursor: "" },
        });
      }
      if (url.pathname.endsWith("/v2/activity/combos")) {
        return Response.json({
          data: [ACTIVITY],
          pagination: { next_cursor: "" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("Polymarket CFB combos", () => {
  test("parses JSON-string arrays", () => {
    expect(parseStringArray('["A", "B"]')).toEqual(["A", "B"]);
    expect(parseStringArray(["A", "B"])).toEqual(["A", "B"]);
    expect(parseStringArray("not-json")).toEqual([]);
  });

  test("extracts both sides of ML/spread/total and skips ineligible/settled", () => {
    const legs = extractComboLegs(EVENT);
    expect(legs).toHaveLength(6);
    expect(legs.map((leg) => leg.outcome)).toEqual([
      "A",
      "B",
      "A -3.5",
      "B +3.5",
      "Over 50.5",
      "Under 50.5",
    ]);
    expect(legs[0]?.price).toBe(0.38);
    expect(legs[2]?.line).toBe(-3.5);
    expect(legs.some((leg) => leg.marketType === "first_half")).toBe(false);
  });

  test("prices a combo as the product of legs and reports quote margin", () => {
    const price = priceCombo([0.38, 0.8], { stakeUsd: 10, quotedPrice: 0.32 });
    expect(price.fairPrice).toBeCloseTo(0.304, 6);
    expect(price.payoutUsd).toBeCloseTo(32.894736, 4);
    expect(price.payoutMultiple).toBeCloseTo(3.289473, 4);
    expect(price.quotedPayoutUsd).toBeCloseTo(31.25, 4);
    expect(price.makerMarginPct).toBeCloseTo(5.263157, 4);
    expect(() => priceCombo([0.5])).toThrow(/two legs/);
    expect(() => priceCombo([0.5, 1])).toThrow(/invalid leg price/);
    expect(parsePriceList("0.38, 0.8")).toEqual([0.38, 0.8]);
  });

  test("resolves leg specs against fetched events", async () => {
    const events = await fetchCfbComboEvents({ gammaBase: base });
    expect(events).toHaveLength(1);
    const resolved = resolveLegSpecs(
      ["cfb-a-b-ml=A", "cfb-a-b-total=Over 50.5", "missing=X"],
      events,
    );
    expect(resolved.legs.map((leg) => leg.price)).toEqual([0.38, 0.5]);
    expect(resolved.missing).toEqual(["missing=X"]);
  });

  test("normalizes combo positions and activity", () => {
    const position = normalizeComboPosition(POSITION);
    expect(position?.status).toBe("OPEN");
    expect(position?.entryCostUsd).toBe(30);
    expect(position?.legs[0]?.marketSlug).toBe("lol-los-ly");
    expect(position?.legs[0]?.currentPrice).toBe(0.695);

    const activity = normalizeComboActivity(ACTIVITY);
    expect(activity?.type).toBe("SPLIT");
    expect(activity?.amountUsd).toBe(30);
    expect(activity?.legs).toHaveLength(1);
  });

  test("summarizes a wallet's combo positions and activity", async () => {
    const summary = await summarizeComboWallet(WALLET, {
      dataBase: base,
      limit: 100,
    });
    expect(summary.openPositions).toBe(1);
    expect(summary.openCostUsd).toBe(30);
    expect(summary.activityByType.SPLIT).toEqual({ count: 1, amountUsd: 30 });
    expect(summary.positions[0]?.legsTotal).toBe(2);
    expect(summary.truncated).toBe(false);
  });
});
