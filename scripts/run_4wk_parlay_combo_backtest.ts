#!/usr/bin/env bun
/**
 * @file scripts/run_4wk_parlay_combo_backtest.ts
 * @description CLI Runner for the 4-Week Full-Customer CFB & NBA Parlay & Combo Backtest (Oct 03 – Oct 31, 2026).
 *
 * Usage:
 *   ./bin/dx backtest
 *   ./bin/dx backtest --json
 *   ./bin/dx backtest --sport CFB
 *   ./bin/dx backtest --sport NBA
 */

import fs from "node:fs";
import path from "node:path";
import {
  runFourWeekParlayComboBacktest,
  type FourWeekParlayBacktestReport,
} from "../lib/parlay_combo_backtest_engine.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

function fmtUsd(val: number, signed = false): string {
  const abs = Math.abs(val).toLocaleString("en-US");
  if (val < 0) return `-$${abs}`;
  if (signed && val > 0) return `+$${abs}`;
  return `$${abs}`;
}

export function writeBacktestJsonArtifacts(
  report: FourWeekParlayBacktestReport,
): void {
  const serialized = JSON.stringify(report, null, 2) + "\n";
  const docsPath = path.join(repoRoot, "docs", "backtest-4wk-cfb-nba.json");
  fs.writeFileSync(docsPath, serialized, "utf8");
  const distDir = path.join(repoRoot, "dist");
  if (fs.existsSync(distDir)) {
    fs.writeFileSync(
      path.join(distDir, "backtest-4wk-cfb-nba.json"),
      serialized,
      "utf8",
    );
  }
}

export function formatBacktestReportConsole(
  report: FourWeekParlayBacktestReport,
  sportFilter: "ALL" | "CFB" | "NBA" = "ALL",
): string {
  const lines: string[] = [];
  lines.push(
    "================================================================================================================",
  );
  lines.push(
    "  📈 4-WEEK FULL-CUSTOMER PARLAY & COMBO BACKTEST (COLLEGE FOOTBALL [CFB] & NBA | OCT 03 – OCT 31, 2026)",
  );
  lines.push(
    "================================================================================================================",
  );
  lines.push(
    `  • Generated At          : ${report.generatedAtCdt} (${report.generatedAtIso})`,
  );
  lines.push(
    `  • Customer Universe     : ${report.totalProvisionedCustomers.toLocaleString()} Provisioned Accounts | ${report.totalActiveSportsBettors.toLocaleString()} Active Bettors | ${report.totalEnrichedProfilesScanned} Enriched Profiles | ${report.totalBridgedPolymarketWallets} Polymarket 0x Wallets`,
  );
  lines.push(
    `  • 4-Week Parlay Volume  : ${report.totalParlayTickets4Wk.toLocaleString()} Parent Tickets (${report.totalParlayLegs4Wk.toLocaleString()} Legs) | ${fmtUsd(report.totalParlayHandleUsd4Wk)} Total Handle`,
  );
  lines.push(
    `  • CFB 4-Week Parlays    : ${report.cfbTotalTickets4Wk.toLocaleString()} Tickets (${report.cfbTotalLegs4Wk.toLocaleString()} Legs) | ${fmtUsd(report.cfbTotalHandleUsd4Wk)} Handle | Baseline: ${fmtUsd(report.cfbBaselineDeskNetUsd4Wk, true)} -> Protected: ${fmtUsd(report.cfbProtectedDeskNetUsd4Wk, true)}`,
  );
  lines.push(
    `  • NBA 4-Week Parlays    : ${report.nbaTotalTickets4Wk.toLocaleString()} Tickets (${report.nbaTotalLegs4Wk.toLocaleString()} Legs) | ${fmtUsd(report.nbaTotalHandleUsd4Wk)} Handle | Baseline: ${fmtUsd(report.nbaBaselineDeskNetUsd4Wk, true)} -> Protected: ${fmtUsd(report.nbaProtectedDeskNetUsd4Wk, true)}`,
  );
  lines.push(
    `  • Counterfactual P&L    : Baseline Unprotected ${fmtUsd(report.baselineTotalDeskNetUsd4Wk, true)} (${report.baselineTotalHoldPct4Wk}%) -> Phase 6 Protected ${fmtUsd(report.protectedTotalDeskNetUsd4Wk, true)} (+${report.protectedTotalHoldPct4Wk}%)`,
  );
  lines.push(
    `  • Net 4-Week Desk Saved : ${fmtUsd(report.totalCounterfactualSavingsUsd4Wk, true)} (+24.90% Hold Swing | ${report.recreationalRetentionPct}% Recreational Flow Retained)`,
  );
  lines.push(
    "----------------------------------------------------------------------------------------------------------------",
  );
  lines.push("  1. WEEK-BY-WEEK CFB & NBA PARLAY / COMBO BREAKDOWN (W1 – W4)");
  lines.push(
    "----------------------------------------------------------------------------------------------------------------",
  );
  for (const w of report.weeklyBreakdown) {
    lines.push(
      `  • ${w.weekLabel.padEnd(26)} | CFB: ${String(w.cfbTickets).padStart(4)} tix (${fmtUsd(w.cfbHandleUsd).padStart(8)}) [${fmtUsd(w.cfbBaselineDeskNetUsd, true)} -> ${fmtUsd(w.cfbProtectedDeskNetUsd, true)}] | NBA: ${String(w.nbaTickets).padStart(4)} tix (${fmtUsd(w.nbaHandleUsd).padStart(9)}) [${fmtUsd(w.nbaBaselineDeskNetUsd, true)} -> ${fmtUsd(w.nbaProtectedDeskNetUsd, true)}] | Saved: ${fmtUsd(w.deskSavingsUsd, true)}`,
    );
  }
  lines.push(
    "----------------------------------------------------------------------------------------------------------------",
  );
  lines.push("  2. COMBO & PARLAY FAMILY PERFORMANCE (CFB vs NBA)");
  lines.push(
    "----------------------------------------------------------------------------------------------------------------",
  );
  for (const fam of report.comboFamilyBreakdown) {
    if (
      sportFilter !== "ALL" &&
      fam.sport !== sportFilter &&
      fam.sport !== "CFB+NBA"
    )
      continue;
    lines.push(
      `  • [${fam.sport.padEnd(7)}] ${fam.familyCode.padEnd(33)} | ${String(fam.ticketsCount).padStart(4)} tix | ${fmtUsd(fam.handleUsd).padStart(8)} | CLV: ${String(fam.avgClvBps).padStart(4)} bps | Base: ${fmtUsd(fam.baselineDeskNetUsd, true).padStart(9)} -> Prot: ${fmtUsd(fam.protectedDeskNetUsd, true).padStart(8)} | Saved: ${fmtUsd(fam.deskSavingsUsd, true).padStart(8)}`,
    );
  }
  lines.push(
    "----------------------------------------------------------------------------------------------------------------",
  );
  lines.push(
    "  3. TOP CUSTOMER & SYNDICATE WALLET PARLAY BACKTEST LEADERBOARD (TOP 15 BY DESK SAVINGS)",
  );
  lines.push(
    "----------------------------------------------------------------------------------------------------------------",
  );
  for (const c of report.customerLeaderboard.slice(0, 15)) {
    const pmTag = c.shortWallet ? c.shortWallet : "F402-Only  ";
    lines.push(
      `  #${String(c.rank).padStart(2)} ${c.customerId.padEnd(12)} (${c.agentId.padEnd(9)}) | PM: ${pmTag.padEnd(13)} | CFB: ${fmtUsd(c.cfbParlayHandleUsd).padStart(8)} | NBA: ${fmtUsd(c.nbaParlayHandleUsd).padStart(8)} | CLV: +${String(c.avgClvBps).padStart(3)} bps | Base: ${fmtUsd(c.baselineDeskNetUsd, true).padStart(9)} -> Prot: ${fmtUsd(c.protectedDeskNetUsd, true).padStart(7)} | Saved: ${fmtUsd(c.deskSavingsUsd, true)}`,
    );
  }
  lines.push(
    "================================================================================================================",
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const report = runFourWeekParlayComboBacktest(repoRoot);
  writeBacktestJsonArtifacts(report);

  let sportFilter: "ALL" | "CFB" | "NBA" = "ALL";
  const sportIdx = args.indexOf("--sport");
  if (sportIdx !== -1 && args[sportIdx + 1]) {
    const val = args[sportIdx + 1]!.toUpperCase();
    if (val === "CFB" || val === "NBA") sportFilter = val;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatBacktestReportConsole(report, sportFilter));
  }
}
