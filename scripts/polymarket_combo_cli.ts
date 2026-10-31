#!/usr/bin/env bun
/**
 * @file scripts/polymarket_combo_cli.ts
 * @description `dx combo` — CFB combo leg discovery, product-of-legs pricing and wallet combo lookups.
 *
 * Usage:
 *   ./bin/dx combo legs --limit 5
 *   ./bin/dx combo price --prices 0.38,0.80 --stake 10 --quoted 0.32
 *   ./bin/dx combo price --legs "cfb-nd-navy-2026-10-31=Notre Dame,cfb-uga-fsu-2026-10-31=Georgia"
 *   ./bin/dx combo wallet 0x26cf...
 */

import { buildComboUniquenessReport } from "../lib/combo_uniqueness.ts";
import {
  CFB_SERIES_ID,
  fetchCfbComboEvents,
  priceCombo,
  resolveLegSpecs,
  summarizeComboWallet,
  type ComboEvent,
  type ComboPrice,
} from "../lib/polymarket_combo.ts";

const HELP = `Polymarket CFB combo helper

Usage:
  bun run scripts/polymarket_combo_cli.ts legs [--limit 10] [--include-started] [--json]
  bun run scripts/polymarket_combo_cli.ts price --prices 0.38,0.80 [--stake 10] [--quoted 0.32]
  bun run scripts/polymarket_combo_cli.ts price --legs "<marketSlug>=<Outcome>,..." [--limit 10]
  bun run scripts/polymarket_combo_cli.ts wallet <0x> [--limit 100] [--max-pages 5] [--json]
  bun run scripts/polymarket_combo_cli.ts uniqueness [--strict-full-game] [--json]

Notes:
  • CFB markets come from Gamma series ${CFB_SERIES_ID}; legs are moneyline/spreads/totals.
  • Fair price is the product of leg probabilities (independent legs, raw prices include vig).
  • Combo discovery is user-anchored: /v2/positions/combos and /v2/activity/combos require a wallet.
  • uniqueness seeds wallets from the PnL leaderboard (add --seed-trades for CFB trades) and
    caches combo responses under .cfb-combo-cache (TTL 24h, bypass with --fresh).
  • Public APIs only; no key.`;

function flag(args: readonly string[], names: readonly string[], fallback: string): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1]!;
  }
  return fallback;
}

const cents = (price: number): string => `${(price * 100).toFixed(1)}¢`;
const usd = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function printLegs(events: readonly ComboEvent[], maxLegs = 12): void {
  const withLegs = events.filter((event) => event.legs.length > 0);
  if (withLegs.length === 0) {
    console.log("No active CFB events with priced legs (in-progress games show 0/1 prices).");
    return;
  }
  for (const event of withLegs) {
    console.log(`\n🏈 ${event.title} (${event.slug})`);
    for (const leg of event.legs.slice(0, maxLegs)) {
      const line = leg.line === null ? "" : ` ${leg.line}`;
      console.log(
        `   ${leg.marketType.padEnd(10)}${line.padEnd(6)} ${leg.outcome.padEnd(22)} @ ${cents(leg.price).padStart(7)}   [${leg.marketSlug}=${leg.outcome}]`,
      );
    }
    if (event.legs.length > maxLegs) {
      console.log(`   … +${event.legs.length - maxLegs} more legs (use --json for all)`);
    }
  }
  const skipped = events.length - withLegs.length;
  if (skipped > 0) console.log(`\n(${skipped} event(s) had no priced legs and were skipped)`);
}

function printPrice(price: ComboPrice): void {
  console.log(
    `Legs: ${price.legPrices.map(cents).join(" × ")} = ${cents(price.fairPrice)} fair`,
  );
  console.log(
    `Stake ${usd(price.stakeUsd)} → ${usd(price.payoutUsd)} if all legs win (${price.payoutMultiple.toFixed(2)}x)`,
  );
  if (price.quotedPrice !== null && price.quotedPayoutUsd !== null && price.makerMarginPct !== null) {
    console.log(
      `Quoted ${cents(price.quotedPrice)} → ${usd(price.quotedPayoutUsd)} | maker margin ${price.makerMarginPct.toFixed(1)}% over fair`,
    );
  }
}

export async function runPolymarketCombo(argv: readonly string[]): Promise<void> {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help") || args.length === 0) {
    console.log(HELP);
    return;
  }
  const sub = args[0]!;
  const json = args.includes("--json");
  const limit = Number(flag(args, ["--limit"], "5"));
  const sleepless = { limit: Number.isFinite(limit) ? limit : 5 };

  if (sub === "legs") {
    const legsLimit = Number(flag(args, ["--limit"], "10"));
    const maxLegs = Number(flag(args, ["--max-legs"], "12"));
    const events = await fetchCfbComboEvents({
      limit: Number.isFinite(legsLimit) ? legsLimit : 10,
      pregameOnly: !args.includes("--include-started"),
    });
    if (json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    printLegs(events, Number.isFinite(maxLegs) ? maxLegs : 12);
    return;
  }

  if (sub === "price") {
    const stake = Number(flag(args, ["--stake"], "10"));
    const quotedRaw = flag(args, ["--quoted"], "");
    const quoted = quotedRaw === "" ? null : Number(quotedRaw);
    const pricesRaw = flag(args, ["--prices"], "");
    let legPrices: number[] = [];
    if (pricesRaw !== "") {
      legPrices = pricesRaw
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((price) => Number.isFinite(price));
    } else {
      const specsRaw = flag(args, ["--legs"], "");
      if (specsRaw === "") {
        console.error("price: provide --prices 0.38,0.80 or --legs \"<slug>=<Outcome>,...\"");
        process.exitCode = 1;
        return;
      }
      const events = await fetchCfbComboEvents({ limit: Number(flag(args, ["--limit"], "10")) });
      const resolved = resolveLegSpecs(
        specsRaw.split(",").map((spec) => spec.trim()).filter((spec) => spec !== ""),
        events,
      );
      if (resolved.missing.length > 0) {
        console.error(`price: could not resolve: ${resolved.missing.join(" | ")}`);
        process.exitCode = 1;
        return;
      }
      legPrices = resolved.legs.map((leg) => leg.price);
    }
    const price = priceCombo(legPrices, {
      stakeUsd: Number.isFinite(stake) ? stake : 10,
      quotedPrice: quoted !== null && Number.isFinite(quoted) ? quoted : null,
    });
    if (json) {
      console.log(JSON.stringify(price, null, 2));
      return;
    }
    printPrice(price);
    return;
  }

  if (sub === "uniqueness") {
    const env = process.env;
    const envFlag = (key: string): boolean => env[key] === "1";
    const walletFile = flag(args, ["--wallet-file"], env.WALLET_FILE ?? "");
    const report = await buildComboUniquenessReport({
      strictFullGame: args.includes("--strict-full-game") || envFlag("STRICT_FULL_GAME"),
      fresh: args.includes("--fresh") || envFlag("FRESH"),
      leaderboard: !args.includes("--no-leaderboard") && env.LEADERBOARD !== "0",
      seedTrades: args.includes("--seed-trades") || envFlag("SEED_TRADES"),
      ...(walletFile !== "" ? { walletFile } : {}),
      limitGames: Number(flag(args, ["--limit-games"], "50")),
      concurrency: Number(flag(args, ["--concurrency"], env.CONCURRENCY ?? "6")),
      leaderboardLimit: Number(flag(args, ["--leaderboard-limit"], env.LEADERBOARD_LIMIT ?? "100")),
      maxSeedMarkets: Number(flag(args, ["--max-seed-markets"], env.MAX_SEED_MARKETS ?? "60")),
      maxComboPages: Number(flag(args, ["--max-combo-pages"], "3")),
      cacheDir: flag(args, ["--cache-dir"], env.CACHE_DIR ?? "scratch/cfb-combo-cache"),
      cacheTtlHours: Number(flag(args, ["--cache-ttl-hours"], env.CACHE_TTL_HOURS ?? "24")),
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `CFB combo uniqueness${report.strictFullGame ? " (strict full-game)" : ""} — games ${report.games.length}, wallets scanned ${report.walletsScanned}`,
    );
    for (const game of report.games.filter((entry) => entry.uniqueCombos > 0)) {
      console.log(`\n🏈 ${game.title} (${game.gameSlug})`);
      console.log(
        `   combos ${game.uniqueCombos} | wallets ${game.uniqueWallets} | fully within game ${game.fullyWithinGame}`,
      );
      for (const sample of game.samples) {
        console.log(
          `   • ${sample.comboId.slice(0, 16)}… by ${sample.wallet.slice(0, 10)}… (${sample.legs} legs, ${sample.games} game${sample.games > 1 ? "s" : ""})`,
        );
      }
    }
    console.log("\nGlobal");
    console.log(`   games with activity : ${report.global.gamesWithActivity}`);
    console.log(`   distinct combos     : ${report.global.distinctCombos}`);
    console.log(`   distinct wallets    : ${report.global.distinctWallets}`);
    console.log(`   sum per-game combos : ${report.global.sumPerGameCombos}`);
    console.log(
      `   cache               : ${report.cache.hits} hit / ${report.cache.misses} miss (ttl ${report.cache.ttlHours}h)`,
    );
    return;
  }

  if (sub === "wallet") {
    const wallet = args.find((arg, index) => index > 0 && !arg.startsWith("-"));
    if (wallet === undefined || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      console.error("wallet: provide a 0x wallet address");
      process.exitCode = 1;
      return;
    }
    const maxPages = Number(flag(args, ["--max-pages"], "5"));
    const summary = await summarizeComboWallet(wallet, {
      limit: Number.isFinite(limit) ? limit : 100,
      maxPages: Number.isFinite(maxPages) ? maxPages : 5,
    });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`Combo wallet ${summary.wallet}`);
    console.log(
      `  open ${summary.openPositions}  |  open cost ${usd(summary.openCostUsd)}  |  pages ${summary.pages}${summary.truncated ? " (truncated)" : ""}`,
    );
    for (const [type, bucket] of Object.entries(summary.activityByType).sort()) {
      console.log(`  ${type.padEnd(10)} ${String(bucket.count).padStart(4)}  ${usd(bucket.amountUsd)}`);
    }
    console.log("");
    for (const position of summary.positions.slice(0, 10)) {
      console.log(
        `  • ${position.outcome} · ${position.status} — cost ${usd(position.entryCostUsd)} @ ${cents(position.entryAvgPrice)} | legs ${position.legsResolved}/${position.legsTotal}`,
      );
      for (const leg of position.legs) {
        console.log(
          `      ${leg.marketSlug || leg.conditionId.slice(0, 12)} ${leg.outcome} ${leg.status}${leg.currentPrice === null ? "" : ` @ ${cents(leg.currentPrice)}`}`,
        );
      }
    }
    return;
  }

  console.error(`combo: unknown subcommand "${sub}"\n`);
  console.log(HELP);
  process.exitCode = 1;
}

if (import.meta.main) {
  runPolymarketCombo(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`combo: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
