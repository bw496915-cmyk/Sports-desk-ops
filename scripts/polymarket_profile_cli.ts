#!/usr/bin/env bun
/**
 * @file scripts/polymarket_profile_cli.ts
 * @description `dx profile` — Polymarket address profiler (public APIs only).
 *
 * Usage:
 *   ./bin/dx profile 0x26cf...c612
 *   ./bin/dx profile BGD101          # leaderboard username lookup
 *   ./bin/dx profile 0x... --json
 */

import {
  profilePolymarketAddress,
  type AddressProfile,
} from "../lib/polymarket_profile.ts";

const HELP = `Polymarket address profiler

Usage:
  bun run scripts/polymarket_profile_cli.ts <0x-address|username> [options]

Options:
  --json                     Print the full profile as JSON
  --max-activity-pages <n>   Cap activity pagination (default 40 pages = 20k rows)
  --timeout-ms <ms>          Per-request timeout (default 15000)
  -h, --help

Data: lb-api (PnL), data-api (positions, activity), gamma-api (categories). No API key.
Activity is paginated by the last timestamp (\`end=\`), not offsets.`;

function flag(
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

const usd = (value: number | null): string =>
  value === null
    ? "N/A"
    : `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

const short = (address: string): string =>
  address.length > 12
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address;

function printProfile(profile: AddressProfile): void {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    `  Polymarket Profile: ${short(profile.address)}${profile.name ? ` (${profile.name})` : ""}`,
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Address:    ${profile.address}`);
  if (profile.pnl.all === null) {
    console.log(
      `  PnL:        ${usd(profile.positionsPnlUsd)} (sum of position cashPnl; lb-api retired)`,
    );
  } else {
    console.log(
      `  Total PnL:  ${usd(profile.pnl.all)}  |  7d ${usd(profile.pnl.d7)}  |  30d ${usd(profile.pnl.d30)}`,
    );
  }
  console.log(
    `  Win Rate:   ${profile.wins}/${profile.wins + profile.losses}` +
      (profile.winRate === null ? " (N/A)" : ` (${profile.winRate}%)`) +
      (profile.winRateEstimated ? " — estimated from activity" : ""),
  );
  console.log(
    `  Positions:  ${profile.openCount} open  |  book value ${usd(profile.portfolioValueUsd)}  |  cost ${usd(profile.investedUsd)}`,
  );
  console.log("");
  console.log(`🎯 Strategy: ${profile.strategy.name}`);
  console.log(`   ${profile.strategy.explanation}`);
  console.log(
    `   ${profile.activity.tradeBuys + profile.activity.tradeSells} trades across ${profile.activity.uniqueMarkets} markets`,
  );

  if (profile.open.length > 0) {
    console.log("");
    console.log(`📈 Open Positions (${profile.open.length})`);
    const top = [...profile.open]
      .sort((a, b) => b.currentValue - a.currentValue)
      .slice(0, 10);
    for (const position of top) {
      console.log(
        `   • ${position.title.slice(0, 64)} ${position.outcome ? `(${position.outcome})` : ""}` +
          ` — value ${usd(position.currentValue)} @ ${position.curPrice.toFixed(3)}  pnl ${usd(position.cashPnl)}`,
      );
    }
  }

  if (profile.categories.length > 0) {
    console.log("");
    console.log("📂 Category Distribution");
    for (const bucket of profile.categories) {
      console.log(
        `   • ${bucket.category.padEnd(12)} ${String(bucket.positions).padStart(3)} pos  ${usd(bucket.valueUsd).padStart(12)}  ${bucket.sharePct}%`,
      );
    }
  }

  console.log("");
  console.log("📋 Activity Summary");
  console.log(
    `   • TRADE BUY   ${String(profile.activity.tradeBuys).padStart(6)}  ${usd(profile.activity.tradeVolume)} volume`,
  );
  console.log(
    `   • TRADE SELL  ${String(profile.activity.tradeSells).padStart(6)}`,
  );
  console.log(`   • SPLIT       ${usd(profile.activity.splitVolume)}`);
  console.log(`   • MERGE       ${usd(profile.activity.mergeVolume)}`);
  console.log(`   • REDEEM      ${usd(profile.activity.redeemVolume)}`);
  console.log(
    `   • pages ${profile.pagesFetched}${profile.activityTruncated ? " (truncated)" : ""}`,
  );

  if (profile.topWins.length > 0 || profile.topLosses.length > 0) {
    console.log("");
    console.log("🏆 Top Settled Winners");
    for (const position of profile.topWins.filter((row) => row.cashPnl > 0)) {
      console.log(
        `   • ${position.title.slice(0, 60)} ${position.outcome} — ${usd(position.cashPnl)}`,
      );
    }
    console.log("💀 Top Settled Losers");
    for (const position of profile.topLosses.filter((row) => row.cashPnl < 0)) {
      console.log(
        `   • ${position.title.slice(0, 60)} ${position.outcome} — ${usd(position.cashPnl)}`,
      );
    }
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

export async function runPolymarketProfile(
  argv: readonly string[],
): Promise<void> {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return;
  }
  const input = (() => {
    const valueFlags = new Set(["--max-activity-pages", "--timeout-ms"]);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (valueFlags.has(arg)) {
        index += 1;
        continue;
      }
      if (arg.startsWith("-")) continue;
      return arg;
    }
    return undefined;
  })();
  if (input === undefined) {
    console.error("profile: provide a 0x address or a leaderboard username\n");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  const maxPages = Number(flag(args, ["--max-activity-pages"], "40"));
  const timeoutMs = Number(flag(args, ["--timeout-ms"], "15000"));

  const profile = await profilePolymarketAddress(input, {
    maxActivityPages: Number.isFinite(maxPages) ? maxPages : 40,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15_000,
  });
  if (profile === null) {
    console.error(
      `profile: could not resolve "${input}" to a Polymarket address`,
    );
    process.exitCode = 1;
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(profile, null, 2));
    return;
  }
  printProfile(profile);
}

if (import.meta.main) {
  runPolymarketProfile(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `profile: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
