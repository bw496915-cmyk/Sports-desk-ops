/**
 * @file lib/terminal_customer_resolve.ts
 * @description Resolve terminal `profile` targets from book corpora, rankings, and live wagers
 * (same sources as `/api/customers/*`), not only the static KNOWN_CUSTOMERS demo matrix.
 */

import { createCustomerRowFinder } from "../packages/backend/src/customers.ts";
import { runBatchedRanking } from "./customer_rankings.ts";
import type { PlayerRankingRecord } from "../scripts/batch_rank_all_players.ts";
import type { TerminalCustomerRecord } from "./terminal_emulator.ts";

type JsonRow = Record<string, unknown>;

let _finder: ReturnType<typeof createCustomerRowFinder<JsonRow>> | null = null;
let _rankingCache: Promise<readonly PlayerRankingRecord[]> | null = null;

function customerRowFinder(): ReturnType<
  typeof createCustomerRowFinder<JsonRow>
> {
  if (_finder === null) {
    _finder = createCustomerRowFinder<JsonRow>();
  }
  return _finder;
}

function rankingPlayers(): Promise<readonly PlayerRankingRecord[]> {
  if (_rankingCache === null) {
    _rankingCache = runBatchedRanking({ limitPlayers: 500 })
      .then((r) => r.topRankedPlayers)
      .catch((err) => {
        _rankingCache = null;
        throw err;
      });
  }
  return _rankingCache;
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonEmptyText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

function str(row: JsonRow, key: string, fallback = "—"): string {
  return nonEmptyText(row[key]) ?? fallback;
}

function scaleSharpScore(sharp: number | null): number {
  if (sharp === null) return 5;
  return Math.min(10, Math.max(0, sharp / 10));
}

function clvBpsToScore(clvBps: number | null): number {
  if (clvBps === null) return 0.8;
  return Math.min(3, Math.max(0, clvBps / 40));
}

function tierFromBookRow(row: JsonRow): string {
  const explicit = nonEmptyText(row.tier);
  if (explicit) return explicit;
  const sharp = finiteNumber(row.sharp_score);
  if (sharp !== null && sharp >= 85) return "TIER_1_ELITE_ORIGINATOR";
  if (sharp !== null && sharp >= 75) return "TIER_2_STEAM_SYNDICATE";
  if (sharp !== null && sharp >= 65) return "TIER_3_SHARP_DISCIPLINED";
  return "TIER_4_SEMI_SHARP";
}

function sampleWagersFromTickets(
  tickets: unknown,
): TerminalCustomerRecord["sampleWagers"] {
  if (!Array.isArray(tickets)) return undefined;
  const out: NonNullable<TerminalCustomerRecord["sampleWagers"]>[number][] = [];
  for (const raw of tickets) {
    if (typeof raw !== "object" || raw === null) continue;
    const t = raw as JsonRow;
    const sport = nonEmptyText(t.league) ?? nonEmptyText(t.sport) ?? "—";
    const market = nonEmptyText(t.market) ?? "—";
    const line = nonEmptyText(t.selection) ?? nonEmptyText(t.line) ?? "—";
    const stakeUsd = finiteNumber(t.risk_usd) ?? finiteNumber(t.stakeUsd) ?? 0;
    const netUsd =
      finiteNumber(t.net_usd) ??
      finiteNumber(t.netUsd) ??
      (finiteNumber(t.win_usd) ?? 0) - stakeUsd;
    out.push({
      sport,
      market,
      line: line.length > 48 ? `${line.slice(0, 45)}…` : line,
      clvBps: finiteNumber(t.clv_bps) ?? 0,
      stakeUsd,
      netUsd,
      time: nonEmptyText(t.placed_at) ?? nonEmptyText(t.time) ?? "—",
    });
    if (out.length >= 8) break;
  }
  return out.length > 0 ? out : undefined;
}

function bookRowToTerminal(row: JsonRow): TerminalCustomerRecord {
  const id = str(row, "customer_id", "UNKNOWN").toUpperCase();
  const sharp = finiteNumber(row.sharp_score);
  const score = scaleSharpScore(sharp);
  const clvBps = finiteNumber(row.clv_bps);
  const ltv = finiteNumber(row.lifetime_net_usd) ?? 0;
  const hold = finiteNumber(row.hold_pct) ?? 0;
  const volume = finiteNumber(row.lifetime_volume_usd) ?? 0;
  const limit = finiteNumber(row.wager_limit_usd) ?? 500;
  const delay = finiteNumber(row.delay_seconds) ?? 3;
  const context = str(row, "context_type", "MIXED");

  return {
    id,
    name: str(row, "name", `Book customer ${id}`),
    agentId: str(row, "agent_id", "—"),
    masterAgent: str(row, "master_agent", str(row, "agent_id", "—")),
    tier: tierFromBookRow(row),
    score,
    clvScore: clvBpsToScore(clvBps),
    skillScore: Math.min(2.5, score * 0.28),
    sizingScore: Math.min(1.5, 0.9 + (volume > 0 ? 0.3 : 0)),
    sigScore: Math.min(2, 1.2),
    timingScore: context.includes("SNIPER") ? 0.9 : 0.6,
    correlatedScore: 0.4,
    sizingStrategy: "BOOK_DERIVED",
    gini: 0.2,
    meanStake:
      volume > 0 && Array.isArray(row.recent_tickets)
        ? volume / Math.max(1, row.recent_tickets.length)
        : 0,
    maxMinRatio: 2,
    specialization: context,
    timingArchetype: context,
    correlatedRisk: "MODERATE",
    correlatedExploitRate: 0.25,
    syndicateRisk: "ELEVATED",
    syndicateProb: 0.35,
    subAccountIndex: null,
    var95Usd: Math.max(1000, Math.abs(ltv) * 0.15),
    cvar95Usd: Math.max(1500, Math.abs(ltv) * 0.2),
    holdPct: hold,
    ltvUsd: ltv,
    recommendedLimitUsd: limit,
    inPlayDelaySec: delay,
    lineShadeCents: 10,
    shadowCopyMultiplier: 0.75,
    action: sharp !== null && sharp >= 80 ? "ALERT_OPERATOR" : "MONITOR",
    ipAddress: str(row, "ip_subnet", "—").split("/")[0] ?? "—",
    sampleWagers: sampleWagersFromTickets(row.recent_tickets),
  };
}

function playerToTerminal(player: PlayerRankingRecord): TerminalCustomerRecord {
  const score = Math.min(10, Math.max(0, player.compositeScore / 10));
  return {
    id: player.customerId.toUpperCase(),
    name: `Ranked player ${player.customerId}`,
    agentId: player.agentId,
    masterAgent: player.masterAgent,
    tier: player.tierLabel || player.tier,
    score,
    clvScore: Math.min(3, score * 0.32),
    skillScore: Math.min(2.5, score * 0.26),
    sizingScore: Math.min(1.5, 1.5 - player.stakeGini * 0.5),
    sigScore: Math.min(2, 1 + player.alertRatePct / 100),
    timingScore: 0.7,
    correlatedScore: player.isProxyConduit ? 0.8 : 0.4,
    sizingStrategy: player.stakeGini > 0.35 ? "VARIABLE_STAKE" : "FLAT_UNIT",
    gini: player.stakeGini,
    meanStake: player.avgStakeUsd,
    maxMinRatio:
      player.medianStakeUsd > 0
        ? player.maxStakeUsd / player.medianStakeUsd
        : 2,
    specialization: `${player.dominantSport} · ${player.dominantBetType}`,
    timingArchetype: player.tierLabel,
    correlatedRisk: player.isProxyConduit ? "HIGH" : "MODERATE",
    correlatedExploitRate: player.alertRatePct / 100,
    syndicateRisk: player.isProxyConduit ? "HIGH" : "ELEVATED",
    syndicateProb: player.isProxyConduit ? 0.75 : 0.4,
    subAccountIndex: null,
    var95Usd: Math.max(1000, player.handleUsd * 0.05),
    cvar95Usd: Math.max(1500, player.handleUsd * 0.08),
    holdPct: 0,
    ltvUsd: player.toWinUsd - player.handleUsd,
    recommendedLimitUsd: player.recommendedLimitUsd,
    inPlayDelaySec: player.recommendedDelaySeconds,
    lineShadeCents: player.recommendedLineShadeCents,
    shadowCopyMultiplier: player.shadowCopyRatio,
    action: player.compositeScore >= 75 ? "ALERT_OPERATOR" : "MONITOR",
    ipAddress: "—",
  };
}

/**
 * Resolve a customer id for terminal profile rendering from local book corpora and rankings.
 */
export async function resolveTerminalCustomer(
  customerId: string,
): Promise<TerminalCustomerRecord | null> {
  const norm = customerId.trim().toUpperCase();
  if (!norm) return null;

  const row = await customerRowFinder().findCustomerRow(norm);
  if (row !== null) {
    return bookRowToTerminal(row);
  }

  try {
    const players = await rankingPlayers();
    const hit = players.find((p) => p.customerId.trim().toUpperCase() === norm);
    if (hit) return playerToTerminal(hit);
  } catch {
    // signal-honesty: rankings artifact optional for terminal profile
  }

  return null;
}

/** Test-only: drop in-memory resolver caches. */
export function clearTerminalCustomerResolveCache(): void {
  _rankingCache = null;
  _finder?.clearCache();
}
