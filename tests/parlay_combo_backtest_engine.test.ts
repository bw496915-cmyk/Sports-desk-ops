import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { runFourWeekParlayComboBacktest } from "../lib/parlay_combo_backtest_engine.ts";

describe("4-Week Full-Customer CFB & NBA Parlay & Combo Backtest Engine", () => {
  const report = runFourWeekParlayComboBacktest();

  test("scans the 9,435-account downline, 220 enriched profiles, and 22 valid Polymarket wallets across 4 weeks", () => {
    expect(report.schemaVersion).toBe(1);
    expect(report.totalProvisionedCustomers).toBe(9435);
    expect(report.totalActiveSportsBettors).toBe(2236);
    expect(report.totalEnrichedProfilesScanned).toBeGreaterThanOrEqual(220);
    expect(report.totalBridgedPolymarketWallets).toBe(22);
    expect(report.weeklyBreakdown.length).toBe(4);
    expect(report.dataBasis.scenarioTicketTotals).toBe(true);
    expect(report.dataBasis.provisionedSource).toBe(
      existsSync("sportsdesk_downline_data.json")
        ? "downline-meta"
        : "snapshot",
    );
    expect(report.dataBasis.sampledTickets).toBe(
      existsSync("enriched_customers_full.json") ? 1100 : 0,
    );
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
    // enriched_customers_full.json is gitignored (customer data). CI falls back to the
    // featured rows (23); a developer checkout with the book gets 30+.
    const hasCustomerBook = existsSync("enriched_customers_full.json");
    expect(report.customerLeaderboard.length).toBeGreaterThanOrEqual(
      hasCustomerBook ? 30 : 23,
    );
    const bgd = report.customerLeaderboard.find(
      (c) => c.customerId === "BGD101",
    );
    expect(bgd).toBeDefined();
    expect(bgd?.f402CustomerProfileUrl).toBe(
      "https://fantasy402.com/manager.html?customer=BGD101",
    );
    expect(bgd?.polymarketProfileUrl).toBe(
      "https://polymarket.com/profile/0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
    );
    expect(bgd?.polymarketPositionsApiUrl).toBe(
      "https://data-api.polymarket.com/positions?user=0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
    );

    const rf = report.customerLeaderboard.find(
      (c) => c.customerId === "RF2003",
    );
    expect(rf).toBeDefined();
    expect(rf?.primaryGuardTriggered).toBe("RECREATIONAL_RETAINED_FLOW");
    expect(rf?.deskSavingsUsd).toBe(0);
  });

  test.if(existsSync("enriched_customers_full.json"))(
    "committed backtest artifact matches the engine output",
    async () => {
      const artifact = (await Bun.file(
        "docs/backtest-4wk-cfb-nba.json",
      ).json()) as Record<string, unknown>;
      const fresh = JSON.parse(JSON.stringify(report)) as Record<
        string,
        unknown
      >;
      delete artifact.generatedAtIso;
      delete artifact.generatedAtCdt;
      delete fresh.generatedAtIso;
      delete fresh.generatedAtCdt;
      expect(fresh).toEqual(artifact);
    },
  );
});
