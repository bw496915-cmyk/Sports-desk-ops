import { describe, expect, test } from "bun:test";
import { runFourWeekParlayComboBacktest } from "../lib/parlay_combo_backtest_engine.ts";

describe("4-Week Full-Customer CFB & NBA Parlay & Combo Backtest Engine", () => {
  const report = runFourWeekParlayComboBacktest();

  test("scans the full 57,755 customer universe, 220 enriched profiles, and 39 bridged Polymarket wallets across 4 weeks", () => {
    expect(report.schemaVersion).toBe(1);
    expect(report.totalProvisionedCustomers).toBe(57755);
    expect(report.totalActiveSportsBettors).toBe(2236);
    expect(report.totalEnrichedProfilesScanned).toBeGreaterThanOrEqual(220);
    expect(report.totalBridgedPolymarketWallets).toBe(39);
    expect(report.weeklyBreakdown.length).toBe(4);
  });

  test("reconciles CFB and NBA 4-week ticket, leg, handle, and counterfactual P&L totals", () => {
    expect(report.cfbTotalTickets4Wk).toBe(4085);
    expect(report.nbaTotalTickets4Wk).toBe(3578);
    expect(report.totalParlayTickets4Wk).toBe(7663);
    expect(report.totalParlayLegs4Wk).toBe(17455);
    expect(report.totalParlayHandleUsd4Wk).toBe(4716200);
    expect(report.baselineTotalDeskNetUsd4Wk).toBe(-412380);
    expect(report.protectedTotalDeskNetUsd4Wk).toBe(762280);
    expect(report.totalCounterfactualSavingsUsd4Wk).toBe(1174660);
    expect(report.recreationalRetentionPct).toBeGreaterThanOrEqual(99.0);
  });

  test("populates customer leaderboard with direct Polymarket profile, positions API, and Fantasy402 profile links", () => {
    expect(report.customerLeaderboard.length).toBeGreaterThanOrEqual(30);
    const bgd = report.customerLeaderboard.find((c) => c.customerId === "BGD101");
    expect(bgd).toBeDefined();
    expect(bgd?.f402CustomerProfileUrl).toBe("https://fantasy402.com/manager.html?customer=BGD101");
    expect(bgd?.polymarketProfileUrl).toBe("https://polymarket.com/profile/0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612");
    expect(bgd?.polymarketPositionsApiUrl).toBe(
      "https://data-api.polymarket.com/positions?user=0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612"
    );

    const rf = report.customerLeaderboard.find((c) => c.customerId === "RF2003");
    expect(rf).toBeDefined();
    expect(rf?.primaryGuardTriggered).toBe("RECREATIONAL_RETAINED_FLOW");
    expect(rf?.deskSavingsUsd).toBe(0);
  });
});
