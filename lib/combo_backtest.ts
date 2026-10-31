/**
 * @file lib/combo_backtest.ts
 * @description Realized-PnL backtest for Polymarket combo activity.
 *
 * Public activity only (SPLIT = cost, REDEEM = payout; TRADE/MERGE/SELL handled if present).
 * This measures what actually happened, not a simulated strategy. Pricing calibration against
 * CLOB price history is a separate step.
 */

import {
  fetchComboActivity,
  type ComboActivityRow,
} from "./polymarket_combo.ts";
import type { ComboUniquenessOptions } from "./combo_uniqueness.ts";

const COST_TYPES = new Set(["SPLIT", "TRADE", "BUY"]);
const PAYOUT_TYPES = new Set(["REDEEM", "MERGE", "SELL"]);

export interface ComboBacktestOptions extends ComboUniquenessOptions {
  readonly wallets: readonly string[];
  readonly days?: number;
  readonly maxPages?: number;
  readonly cfbOnly?: boolean;
  readonly gameIndex?: ReadonlyMap<string, string>;
  readonly gameBySlug?: ReadonlyMap<string, string>;
}

export interface ComboBacktestTrade {
  readonly comboId: string;
  readonly wallet: string;
  readonly entryIso: string;
  readonly exitIso: string | null;
  readonly costUsd: number;
  readonly payoutUsd: number;
  readonly pnlUsd: number;
  readonly legs: number;
  readonly games: readonly string[];
  readonly open: boolean;
}

export interface ComboBacktestDay {
  readonly date: string;
  readonly combos: number;
  readonly costUsd: number;
  readonly payoutUsd: number;
  readonly pnlUsd: number;
  readonly roiPct: number | null;
}

export interface ComboBacktestReport {
  readonly fromIso: string;
  readonly toIso: string;
  readonly wallets: number;
  readonly cfbOnly: boolean;
  readonly totals: {
    readonly combos: number;
    readonly settled: number;
    readonly open: number;
    readonly costUsd: number;
    readonly payoutUsd: number;
    readonly pnlUsd: number;
    readonly roiPct: number | null;
    readonly winRatePct: number | null;
    readonly avgLegs: number;
    readonly crossGamePct: number | null;
  };
  readonly byDay: readonly ComboBacktestDay[];
  readonly byGame: readonly {
    readonly game: string;
    readonly combos: number;
    readonly costUsd: number;
    readonly pnlUsd: number;
  }[];
  readonly trades: readonly ComboBacktestTrade[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dayOf(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

function gamesOfCombo(
  legs: readonly { conditionId: string; marketSlug: string }[],
  options: ComboBacktestOptions,
): string[] {
  const games = new Set<string>();
  for (const leg of legs) {
    const byId = options.gameIndex?.get(leg.conditionId.toLowerCase());
    if (byId !== undefined) {
      games.add(byId);
      continue;
    }
    const bySlug = options.gameBySlug?.get(leg.marketSlug);
    if (bySlug !== undefined) games.add(bySlug);
  }
  return [...games];
}

/** Groups activity per combo and computes realized cost/payout/PnL. */
export function buildComboBacktestReport(
  activity: readonly ComboActivityRow[],
  options: ComboBacktestOptions,
): ComboBacktestReport {
  const days = Math.max(1, options.days ?? 30);
  const now = options.now ?? Date.now();
  const from = now - days * 86_400_000;

  const groups = new Map<
    string,
    {
      wallet: string;
      comboId: string;
      cost: number;
      payout: number;
      entry: number;
      exit: number | null;
      legs: number;
      games: string[];
    }
  >();
  for (const row of activity) {
    if (row.timestamp * 1000 < from) continue;
    const key = `${row.comboConditionId}|${row.wallet}`;
    const group = groups.get(key) ?? {
      wallet: row.wallet,
      comboId: row.comboConditionId,
      cost: 0,
      payout: 0,
      entry: row.timestamp,
      exit: null,
      legs: row.legs.length,
      games: gamesOfCombo(row.legs, options),
    };
    group.entry = Math.min(group.entry, row.timestamp);
    if (COST_TYPES.has(row.type)) group.cost += row.amountUsd;
    if (PAYOUT_TYPES.has(row.type)) {
      group.payout +=
        row.type === "REDEEM" ? (row.payoutUsd ?? 0) : row.amountUsd;
      group.exit =
        group.exit === null
          ? row.timestamp
          : Math.max(group.exit, row.timestamp);
    }
    group.legs = Math.max(group.legs, row.legs.length);
    groups.set(key, group);
  }

  const trades: ComboBacktestTrade[] = [];
  for (const group of groups.values()) {
    if (group.cost <= 0) continue;
    if (options.cfbOnly !== false && group.games.length === 0) continue;
    const open = group.exit === null;
    trades.push({
      comboId: group.comboId,
      wallet: group.wallet,
      entryIso: new Date(group.entry * 1000).toISOString(),
      exitIso:
        group.exit === null ? null : new Date(group.exit * 1000).toISOString(),
      costUsd: round2(group.cost),
      payoutUsd: round2(group.payout),
      pnlUsd: round2(group.payout - group.cost),
      legs: group.legs,
      games: group.games,
      open,
    });
  }
  trades.sort((a, b) => a.entryIso.localeCompare(b.entryIso));

  const settled = trades.filter((trade) => !trade.open);
  const cost = settled.reduce((sum, trade) => sum + trade.costUsd, 0);
  const payout = settled.reduce((sum, trade) => sum + trade.payoutUsd, 0);
  const pnl = payout - cost;
  const wins = settled.filter((trade) => trade.pnlUsd > 0).length;
  const hasGameIndex =
    options.gameIndex !== undefined || options.gameBySlug !== undefined;
  const crossGame = settled.filter((trade) => trade.games.length > 1).length;

  const dayBuckets = new Map<
    string,
    { combos: number; cost: number; payout: number }
  >();
  for (const trade of settled) {
    const date = dayOf(Date.parse(trade.entryIso) / 1000);
    const bucket = dayBuckets.get(date) ?? { combos: 0, cost: 0, payout: 0 };
    bucket.combos += 1;
    bucket.cost += trade.costUsd;
    bucket.payout += trade.payoutUsd;
    dayBuckets.set(date, bucket);
  }
  const byDay: ComboBacktestDay[] = [...dayBuckets.entries()]
    .map(([date, bucket]) => ({
      date,
      combos: bucket.combos,
      costUsd: round2(bucket.cost),
      payoutUsd: round2(bucket.payout),
      pnlUsd: round2(bucket.payout - bucket.cost),
      roiPct:
        bucket.cost > 0
          ? round2(((bucket.payout - bucket.cost) / bucket.cost) * 100)
          : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const gameBuckets = new Map<
    string,
    { combos: number; cost: number; pnl: number }
  >();
  for (const trade of settled) {
    for (const game of trade.games) {
      const bucket = gameBuckets.get(game) ?? { combos: 0, cost: 0, pnl: 0 };
      bucket.combos += 1;
      bucket.cost += trade.costUsd;
      bucket.pnl += trade.pnlUsd;
      gameBuckets.set(game, bucket);
    }
  }
  const byGame = [...gameBuckets.entries()]
    .map(([game, bucket]) => ({
      game,
      combos: bucket.combos,
      costUsd: round2(bucket.cost),
      pnlUsd: round2(bucket.pnl),
    }))
    .sort((a, b) => b.pnlUsd - a.pnlUsd);

  return {
    fromIso: new Date(from).toISOString(),
    toIso: new Date(now).toISOString(),
    wallets: options.wallets.length,
    cfbOnly: options.cfbOnly !== false,
    totals: {
      combos: trades.length,
      settled: settled.length,
      open: trades.length - settled.length,
      costUsd: round2(cost),
      payoutUsd: round2(payout),
      pnlUsd: round2(pnl),
      roiPct: cost > 0 ? round2((pnl / cost) * 100) : null,
      winRatePct:
        settled.length > 0 ? round2((wins / settled.length) * 100) : null,
      avgLegs:
        trades.length > 0
          ? round2(
              trades.reduce((sum, trade) => sum + trade.legs, 0) /
                trades.length,
            )
          : 0,
      crossGamePct:
        hasGameIndex && settled.length > 0
          ? round2((crossGame / settled.length) * 100)
          : null,
    },
    byDay,
    byGame,
    trades,
  };
}

/** Fetches combo activity for each wallet and builds the report. */
export async function runComboBacktest(
  options: ComboBacktestOptions,
): Promise<ComboBacktestReport> {
  const activity: ComboActivityRow[] = [];
  for (const wallet of options.wallets) {
    const result = await fetchComboActivity(wallet, {
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
      ...(options.dataBase === undefined ? {} : { dataBase: options.dataBase }),
      limit: 500,
      maxPages: options.maxPages ?? 5,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
    activity.push(...result.activity);
  }
  return buildComboBacktestReport(activity, options);
}
