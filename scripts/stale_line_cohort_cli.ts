#!/usr/bin/env bun
/**
 * @file scripts/stale_line_cohort_cli.ts
 * @description CLI for stale-line / post-move bet cohort detection.
 *
 * Input: a bet-log export as JSON array, JSONL, or CSV. Required columns: `customer`, `placedAt`.
 * Strongly recommended: `eventId`, `market`, `period`, `side`, `priceAmerican`, `stakeUsd`,
 * `settledAt`, `canceledAt`, `status`, `staleNote`, `notedBy`, `agent`, `ip`.
 *
 * Usage:
 *   bun run scripts/stale_line_cohort_cli.ts -i bets.json --window-min 10
 *   bun run scripts/stale_line_cohort_cli.ts -i bets.csv --json
 *   cat bets.jsonl | bun run scripts/stale_line_cohort_cli.ts -i - --top 5
 */

import { readFileSync } from "node:fs";
import {
  buildStaleCohortReport,
  parseStaleTicketInput,
  StaleCohortInputError,
} from "../lib/stale_line_cohort.ts";

const HELP = `Stale-line / post-move bet cohort detector

Usage:
  bun run scripts/stale_line_cohort_cli.ts -i <file|-> [options]

Options:
  -i, --input <path>       JSON array, JSONL, or CSV export ("-" reads stdin)
      --window-min <n>     Same-event clustering window in minutes (default 10)
      --top <n>            Customers to print in text mode (default 15)
      --json               Print the full report as JSON
  -h, --help

A ticket is a seed only when staleNote matches "stale|should have been down|line moved|off the board",
or when status=CANCELLED and it was graded (settledAt) before being cancelled.

Columns (case/punctuation insensitive): customer, agent, ticketId, eventId, market, period, side,
priceAmerican, stakeUsd, placedAt, settledAt, canceledAt, status, staleNote, notedBy, ip.`;

function flagValue(
  args: readonly string[],
  names: readonly string[],
  fallback: string,
): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1]!;
  }
  return fallback;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return;
  }

  const inputPath = flagValue(args, ["-i", "--input"], "");
  if (inputPath === "") {
    console.error("stale-line: missing -i/--input (use - for stdin)\n");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  const windowMinutes = Number(flagValue(args, ["--window-min"], "10"));
  const top = Number(flagValue(args, ["--top"], "15"));

  let source: string;
  try {
    source =
      inputPath === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(inputPath, "utf8");
  } catch (error) {
    console.error(
      `stale-line: cannot read ${inputPath}: ${(error as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = buildStaleCohortReport(parseStaleTicketInput(source), {
      windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : 10,
    });
  } catch (error) {
    if (error instanceof StaleCohortInputError) {
      console.error(`stale-line: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    "==========================================================================================",
  );
  console.log(
    `  🕵️ STALE-LINE / POST-MOVE COHORT  (±${report.windowMinutes}m same-event window)`,
  );
  console.log(
    "==========================================================================================",
  );
  console.log(
    `  tickets=${report.totals.tickets}  seeds=${report.totals.seeds}  clusters=${report.totals.clusters}  customers=${report.totals.customers}`,
  );
  for (const warning of report.warnings) console.log(`  ⚠ ${warning}`);
  console.log(
    "------------------------------------------------------------------------------------------",
  );

  if (report.clusters.length === 0) {
    console.log(
      "  No seeded clusters. A seed needs a stale operator note or a graded-then-cancelled ticket.",
    );
  }
  report.clusters.forEach((cluster, index) => {
    console.log(
      `  #${index + 1} ${cluster.market}/${cluster.period} ${cluster.side} @ ${cluster.eventId || "(no event)"}`,
    );
    console.log(
      `     ${cluster.firstPlacedAtIso} .. ${cluster.lastPlacedAtIso} (${cluster.spreadSeconds}s) | seeds=${cluster.seedTicketIds.length} accounts=${cluster.customerIds.length}`,
    );
    for (const ticket of cluster.tickets) {
      const marker = ticket.isSeed ? "★" : " ";
      console.log(
        `     ${marker} ${ticket.customer.padEnd(12)} ${ticket.placedAtIso}  ${String(ticket.priceAmerican ?? "—").padStart(5)}  $${ticket.stakeUsd.toFixed(2)}  ${ticket.status}`,
      );
    }
    if (cluster.followUpUrl) console.log(`     → ${cluster.followUpUrl}`);
    console.log("");
  });

  console.log(
    "------------------------------------------------------------------------------------------",
  );
  console.log("  Customers by seed count:");
  for (const customer of report.customers.slice(0, Math.max(1, top))) {
    console.log(
      `  • ${customer.customer.padEnd(12)} agent=${(customer.agent || "—").padEnd(10)} seeds=${customer.seeds}/${customer.tickets} (${customer.staleRatePct}%)` +
        ` clustered=${customer.clusteredTickets} canceled=${customer.canceled} graded→canceled=${customer.gradedThenCanceled}` +
        (customer.ip24.length > 0 ? ` ip24=${customer.ip24.join(",")}` : ""),
    );
  }
  console.log(
    "==========================================================================================",
  );
}

if (import.meta.main) main();
