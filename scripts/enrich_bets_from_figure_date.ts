#!/usr/bin/env bun
/**
 * @file scripts/enrich_bets_from_figure_date.ts
 * @description Streaming enrichment engine joining f402-bets.jsonl with /cloud/api/Report/getWagersByFigureDate.
 *
 * Adheres strictly to AGENTS.md data-handling budgets:
 * - Settled batch rows indexed in memory by composite match key (< 5 MB budget).
 * - Live ticker JSONL processed strictly via line-by-line stream (never loads whole file into memory).
 *
 * Usage:
 *   bun run scripts/enrich_bets_from_figure_date.ts --figure scratch/figure_date.json --ticker probes/out13/f402-bets.jsonl --output scratch/f402-bets-enriched.jsonl
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as readline from "node:readline";
import {
  buildCompositeMatchKey,
  enrichWagerRecord,
  inferTotalPicks,
  parseBuyPointsFromDesc,
  type FigureDateWager,
  type LiveTickerWager,
} from "../lib/f402_figure_date_enricher.ts";
import { classifyPortalPeriod } from "../lib/portal_period_taxonomy.ts";

function printUsage(): void {
  console.log(`
Fantasy402 Figure Date Enrichment Engine
========================================
Joins live ticker wagers with settled ground-truth records.

Options:
  --figure <path>    Path to getWagersByFigureDate JSON payload or JSONL
  --ticker <path>    Path to raw f402-bets.jsonl stream
  --output <path>    Path to emit enriched JSONL wagers
  --stats            Output match rate and summary statistics
  --help             Show this help message
`);
}

interface CliOptions {
  figurePath: string;
  tickerPath: string;
  outputPath: string;
  stats: boolean;
}

function parseCliArgs(args: string[]): CliOptions {
  let figurePath = "";
  let tickerPath = resolve(process.cwd(), "probes/out13/f402-bets.jsonl");
  let outputPath = resolve(process.cwd(), "scratch/f402-bets-enriched.jsonl");
  let stats = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--figure" && i + 1 < args.length) {
      const val = args[++i];
      if (val) figurePath = resolve(process.cwd(), val);
    } else if (arg === "--ticker" && i + 1 < args.length) {
      const val = args[++i];
      if (val) tickerPath = resolve(process.cwd(), val);
    } else if (arg === "--output" && i + 1 < args.length) {
      const val = args[++i];
      if (val) outputPath = resolve(process.cwd(), val);
    } else if (arg === "--no-stats") {
      stats = false;
    }
  }

  if (!figurePath) {
    console.error("Error: Missing required argument --figure <path>");
    printUsage();
    process.exit(1);
  }

  return { figurePath, tickerPath, outputPath, stats };
}

async function loadFigureIndex(
  filePath: string,
): Promise<Map<string, FigureDateWager>> {
  const index = new Map<string, FigureDateWager>();
  const content = await readFile(filePath, "utf-8");

  let records: FigureDateWager[] = [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      records = parsed;
    } else if (parsed?.LIST?.INFO && Array.isArray(parsed.LIST.INFO)) {
      records = parsed.LIST.INFO;
    } else if (parsed?.rows && Array.isArray(parsed.rows)) {
      records = parsed.rows;
    }
  } catch {
    // If not single JSON, parse line-by-line JSONL
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // ignore unparseable lines
      }
    }
  }

  for (const rec of records) {
    const key = buildCompositeMatchKey(
      String(rec.CustomerID || ""),
      String(rec.AcceptedDateTime || ""),
      Number(rec.AmountWagered || 0),
      Number(rec.ToWinAmount || 0),
      String(rec.Description || ""),
    );
    index.set(key, rec);
  }

  return index;
}

export async function runEnrichment(options: CliOptions): Promise<{
  totalTickerRows: number;
  matchedRows: number;
  unmatchedRows: number;
  enrichedOutPath: string;
}> {
  if (!existsSync(options.figurePath)) {
    throw new Error(`Figure file not found: ${options.figurePath}`);
  }
  if (!existsSync(options.tickerPath)) {
    throw new Error(`Ticker file not found: ${options.tickerPath}`);
  }

  const figureIndex = await loadFigureIndex(options.figurePath);
  let totalTickerRows = 0;
  let matchedRows = 0;
  let unmatchedRows = 0;

  const inStream = createReadStream(options.tickerPath, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: inStream,
    crlfDelay: Infinity,
  });

  const outStream = createWriteStream(options.outputPath, {
    flags: "w",
    encoding: "utf-8",
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalTickerRows++;

    let tickerRow: LiveTickerWager;
    try {
      tickerRow = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Skip ALERT mirrors if VolumeAmount === 0 to avoid double counting
    if (tickerRow.TicketWriter === "ALERT" && tickerRow.VolumeAmount === 0) {
      continue;
    }

    const matchKey = buildCompositeMatchKey(
      String(tickerRow.CustomerID || ""),
      String(tickerRow.InsertDateTime || ""),
      Number(tickerRow.AmountWagered || 0),
      Number(tickerRow.ToWinAmount || 0),
      String(tickerRow.ShortDesc || ""),
    );

    const figureRow = figureIndex.get(matchKey);
    if (figureRow) {
      matchedRows++;
      const enriched = enrichWagerRecord(tickerRow, figureRow);
      outStream.write(JSON.stringify(enriched) + "\n");
    } else {
      unmatchedRows++;
      const periodClassification = classifyPortalPeriod({
        ShortDesc: tickerRow.ShortDesc,
        WagerType: tickerRow.WagerType,
      });
      // Output pending un-enriched row with consistent schema flag
      outStream.write(
        JSON.stringify({
          ticketNumber: String(tickerRow.WagerNumber),
          liveWagerNumber: tickerRow.WagerNumber,
          customerId: String(tickerRow.CustomerID || "").trim(),
          agentLogin: String(
            tickerRow.AgentLogin || tickerRow.AgentID || "",
          ).trim(),
          ticketWriter: String(tickerRow.TicketWriter || "").trim(),
          volumeAmount: Number(
            tickerRow.VolumeAmount ?? tickerRow.AmountWagered ?? 0,
          ),
          totalPicks: inferTotalPicks(tickerRow.WagerType, tickerRow.ShortDesc),
          eventId: "UNSETTLED",
          sport: "Unknown",
          subSport: "Unknown",
          opponents: { away: "", home: "" },
          gameDateTime: tickerRow.InsertDateTime,
          acceptedDateTime: tickerRow.InsertDateTime,
          dailyFigureDate: tickerRow.InsertDateTime.slice(0, 10),
          latencySeconds: 0,
          isLateSteam: false,
          isLive: /LIVE/i.test(tickerRow.ShortDesc || ""),
          portalPeriod: periodClassification.portalPeriod,
          periodNumber: periodClassification.portalPeriod ?? 0,
          periodDescription: periodClassification.portalLabel,
          marketType: "other",
          buyPoints: parseBuyPointsFromDesc(tickerRow.ShortDesc || ""),
          origSpread: null,
          adjSpread: null,
          origTotalPoints: null,
          adjTotalPoints: null,
          selection: {
            chosenTeam: "",
            line: null,
            origLine: null,
            buyPoints: parseBuyPointsFromDesc(tickerRow.ShortDesc || ""),
            price: null,
            overUnder: null,
          },
          settlement: {
            isSettled: false,
            status: "P",
            outcome: "PENDING",
            amountWageredCents: Number(tickerRow.AmountWagered || 0),
            toWinCents: Number(tickerRow.ToWinAmount || 0),
            amountWonCents: 0,
            amountLostCents: 0,
            netPnlCents: 0,
            awayScore: null,
            homeScore: null,
          },
        }) + "\n",
      );
    }
  }

  await new Promise<void>((resolve, reject) => {
    outStream.end((err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });

  if (options.stats) {
    console.log("Enrichment Run Summary:");
    console.log(`- Settled Figure Records Indexed: ${figureIndex.size}`);
    console.log(`- Ticker Rows Streamed:           ${totalTickerRows}`);
    console.log(`- Exact Matched & Enriched:       ${matchedRows}`);
    console.log(`- Unmatched (Pending):            ${unmatchedRows}`);
    console.log(`- Enriched JSONL Output:          ${options.outputPath}`);
  }

  return {
    totalTickerRows,
    matchedRows,
    unmatchedRows,
    enrichedOutPath: options.outputPath,
  };
}

if (import.meta.main) {
  const options = parseCliArgs(process.argv.slice(2));
  runEnrichment(options).catch((err) => {
    console.error("Fatal enrichment error:", err);
    process.exit(1);
  });
}
