import { describe, expect, test } from "bun:test";
import { buildComboBacktestReport } from "../lib/combo_backtest.ts";
import type { ComboActivityRow, ComboPositionLeg } from "../lib/polymarket_combo.ts";

const WALLET = "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612";
const NOW = Date.parse("2026-10-31T12:00:00Z");
const DAY = 86_400;

function leg(conditionId: string, marketSlug = ""): ComboPositionLeg {
  return {
    index: 0,
    conditionId,
    outcome: "Yes",
    status: "OPEN",
    currentPrice: 0.5,
    marketSlug,
    marketType: "moneyline",
    line: null,
  };
}

function row(
  id: string,
  type: string,
  comboId: string,
  amountUsd: number,
  payoutUsd: number | null,
  timestamp: number,
  legs: ComboPositionLeg[],
): ComboActivityRow {
  return {
    id,
    type,
    wallet: WALLET,
    amountUsd,
    payoutUsd,
    timestamp,
    comboConditionId: comboId,
    legs,
  };
}

const T0 = Math.floor(NOW / 1000) - 2 * DAY;
const ACTIVITY: ComboActivityRow[] = [
  row("a1", "SPLIT", "0xA", 10, null, T0, [leg("0x1")]),
  row("a2", "REDEEM", "0xA", 0, 30, T0 + 100, [leg("0x1")]),
  row("b1", "SPLIT", "0xB", 5, null, T0 + DAY, [leg("0x1")]),
  row("c1", "SPLIT", "0xC", 4, null, T0 + DAY, [leg("0x1")]),
  row("c2", "REDEEM", "0xC", 0, 0, T0 + DAY + 50, [leg("0x1")]),
  row("d1", "SPLIT", "0xD", 7, null, T0 + DAY, [leg("0x9")]),
];

describe("combo realized-PnL backtest", () => {
  test("aggregates cost/payout per combo and excludes open positions from realized totals", () => {
    const report = buildComboBacktestReport(ACTIVITY, {
      wallets: [WALLET],
      days: 30,
      now: NOW,
      cfbOnly: true,
      gameIndex: new Map([["0x1", "cfb-g1"]]),
      gameBySlug: new Map([["g1-ml", "cfb-g1"]]),
    });

    expect(report.totals.combos).toBe(3); // A, B, C; D is not CFB
    expect(report.totals.settled).toBe(2);
    expect(report.totals.open).toBe(1);
    expect(report.totals.costUsd).toBe(14);
    expect(report.totals.payoutUsd).toBe(30);
    expect(report.totals.pnlUsd).toBe(16);
    expect(report.totals.roiPct).toBeCloseTo(114.29, 2);
    expect(report.totals.winRatePct).toBe(50);
    expect(report.totals.avgLegs).toBe(1);
    expect(report.totals.crossGamePct).toBe(0);

    expect(report.byDay).toEqual([
      { date: "2026-10-29", combos: 1, costUsd: 10, payoutUsd: 30, pnlUsd: 20, roiPct: 200 },
      { date: "2026-10-30", combos: 1, costUsd: 4, payoutUsd: 0, pnlUsd: -4, roiPct: -100 },
    ]);
    expect(report.byGame[0]).toEqual({ game: "cfb-g1", combos: 2, costUsd: 14, pnlUsd: 16 });
  });

  test("all-venues mode includes combos without a CFB game", () => {
    const report = buildComboBacktestReport(ACTIVITY, {
      wallets: [WALLET],
      days: 30,
      now: NOW,
      cfbOnly: false,
    });
    expect(report.totals.combos).toBe(4);
    expect(report.totals.open).toBe(2); // B and D
    expect(report.totals.settled).toBe(2);
  });

  test("ignores activity outside the day window", () => {
    const report = buildComboBacktestReport(ACTIVITY, {
      wallets: [WALLET],
      days: 1,
      now: NOW,
      cfbOnly: false,
    });
    // A is two days before NOW; the 1-day window starts at 2026-10-30T12:00Z, so A is excluded
    // while B/C/D sit exactly on the boundary and remain.
    expect(report.totals.combos).toBe(3);
    expect(report.trades.some((trade) => trade.comboId === "0xA")).toBe(false);
  });
});
