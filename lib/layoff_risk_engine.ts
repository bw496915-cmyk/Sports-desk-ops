/**
 * @file layoff_risk_engine.ts
 * @description Sliding-Window Correlation Engine, Line Delta Evaluator, and Layoff Risk Engine (CFB, NFL, NBA, All Periods).
 *
 * Implements:
 * 1. Line Delta Evaluation: ABS(internal_line - poly_line) in LineHundredths across Game, 1H, 2H, Q1-Q4, Live.
 * 2. Key Number Detection: Football (3, 7, 10, 14) and Basketball/NBA (3, 4, 5, 6, 7, 8).
 * 3. Layoff Risk Alerts: Detects SHARP_STILL_BETTER conditions where Polymarket sharp beats F402 pending line.
 * 4. Period & Sport Matrix: Summarizes pending & matched exposure across CFB, NFL, and NBA across all periods.
 */

import type { Database } from "bun:sqlite";
import { formatLineHundredths, type LineHundredths } from "./combo_identity.ts";
import { sqlInt, sqlIntOrNull } from "./sportsdesk_sqlite.ts";

export interface LineDeltaMatch {
  readonly gameId: string;
  readonly period: string;
  readonly subject: string;
  readonly marketKind: string;
  readonly side: string;
  readonly polyTicket: string;
  readonly polyWallet: string;
  readonly polyLineHundredths: LineHundredths | null;
  readonly f402Ticket: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly f402LineHundredths: LineHundredths | null;
  readonly deltaHundredths: number;
  readonly betterVenue: "polymarket" | "internal" | "equal";
  readonly keyNumberCrossed: number | null;
  readonly isLayoffRisk: boolean;
  readonly alertReason: string | null;
}

export interface SportPeriodBreakdown {
  readonly sport: string;
  readonly period: string;
  readonly pendingLegs: number;
  readonly matchedLegs: number;
  readonly layoffRisks: number;
  readonly polymarketEligible: boolean;
}

export interface CorrelationEngineSummary {
  readonly totalMatches: number;
  readonly exactMatches: number;
  readonly adjacentMatches: number;
  readonly sgpPairs: number;
  readonly layoffRisks: readonly LineDeltaMatch[];
  readonly baylorClusterCount: number;
  readonly nbaClusterCount: number;
  readonly settledTroyCount: number;
  readonly sportPeriodBreakdown: readonly SportPeriodBreakdown[];
}

/** Football spread key numbers in hundredths */
export const SPREAD_KEY_NUMBERS: readonly number[] = [300, 700, 1000, 1400];

/** NBA spread key numbers in hundredths (3, 4, 5, 6, 7, 8) */
export const NBA_SPREAD_KEY_NUMBERS: readonly number[] = [300, 400, 500, 600, 700, 800];

/** Checks if two spread lines span across a key number (e.g. -650 and -750 spans -700) */
export function detectKeyNumberCrossing(
  lineA: number | null,
  lineB: number | null,
  sportPrefix: string = "NFL",
): number | null {
  if (lineA === null || lineB === null) return null;
  const absA = Math.abs(lineA);
  const absB = Math.abs(lineB);
  const min = Math.min(absA, absB);
  const max = Math.max(absA, absB);

  const keys = sportPrefix.startsWith("NBA") ? NBA_SPREAD_KEY_NUMBERS : SPREAD_KEY_NUMBERS;

  for (const key of keys) {
    if (min < key && max > key) {
      return key / 100;
    }
    if (min === key || max === key) {
      return key / 100;
    }
  }
  return null;
}

/**
 * Determines which venue obtained the more favorable line for the bettor.
 */
export function evaluateBetterVenue(
  marketKind: string,
  side: string,
  polyLine: number | null,
  f402Line: number | null,
): "polymarket" | "internal" | "equal" {
  if (polyLine === null || f402Line === null || polyLine === f402Line) {
    return "equal";
  }

  if ((marketKind === "total" || marketKind === "team_total") && side === "OVER") {
    return polyLine < f402Line ? "polymarket" : "internal";
  }

  return polyLine > f402Line ? "polymarket" : "internal";
}

export class LayoffRiskEngine {
  constructor(private readonly db: Database) {}

  /**
   * Evaluates line delta matches between Polymarket and F402 within a max delta threshold.
   * Joins on (game_id, period, subject, market_kind, side) so period 0 (game) never false-matches 1H or Q1.
   */
  queryLineDeltaMatches(maxDeltaHundredths: number = 100): LineDeltaMatch[] {
    const rows = this.db
      .query(
        `SELECT
          pm.game_id,
          COALESCE(pm.period, 'game') AS period,
          pm.subject,
          pm.market_kind,
          pm.side,
          pm.source_ticket AS poly_ticket,
          pm.wallet_or_account AS poly_wallet,
          pm.line_hundredths AS poly_line,
          f402.source_ticket AS f402_ticket,
          f402.wallet_or_account AS customer_id,
          COALESCE(f402.agent_id, 'UNKNOWN') AS agent_id,
          f402.line_hundredths AS f402_line,
          ABS(COALESCE(f402.line_hundredths, 0) - COALESCE(pm.line_hundredths, 0)) AS delta_hundredths,
          attr.agent_owner
        FROM combo_observations_legs pm
        JOIN combo_observations_legs f402
          ON pm.game_id = f402.game_id
         AND COALESCE(pm.period, 'game') = COALESCE(f402.period, 'game')
         AND pm.subject = f402.subject
         AND pm.market_kind = f402.market_kind
         AND pm.side = f402.side
        LEFT JOIN wallet_customer_attributions attr
          ON LOWER(attr.proxy_wallet) = LOWER(pm.wallet_or_account)
         AND UPPER(attr.customer_id) = UPPER(f402.wallet_or_account)
        WHERE pm.source_venue = 'polymarket'
          AND f402.source_venue = 'f402'
          AND f402.status = 'pending'
          AND ABS(COALESCE(f402.line_hundredths, 0) - COALESCE(pm.line_hundredths, 0)) <= ?1
        ORDER BY delta_hundredths ASC, pm.placed_at DESC`,
      )
      .all(maxDeltaHundredths) as Array<{
        game_id: string;
        period: string;
        subject: string;
        market_kind: string;
        side: string;
        poly_ticket: string;
        poly_wallet: string;
        poly_line: number | bigint | null;
        f402_ticket: string;
        customer_id: string;
        agent_id: string;
        f402_line: number | bigint | null;
        delta_hundredths: number | bigint;
        agent_owner: string | null;
      }>;

    return rows.map((r) => {
      const polyLine = sqlIntOrNull(r.poly_line);
      const f402Line = sqlIntOrNull(r.f402_line);
      const betterVenue = evaluateBetterVenue(
        r.market_kind,
        r.side,
        polyLine,
        f402Line,
      );

      const keyNumberCrossed =
        r.market_kind === "spread"
          ? detectKeyNumberCrossing(polyLine, f402Line, r.game_id)
          : null;

      const isLayoffRisk = betterVenue === "polymarket";

      let alertReason: string | null = null;
      if (isLayoffRisk) {
        const polyStr = formatLineHundredths(polyLine as LineHundredths);
        const f402Str = formatLineHundredths(f402Line as LineHundredths);
        const keyTag = keyNumberCrossed ? ` (Crosses Key ${keyNumberCrossed})` : "";
        alertReason = `SHARP_STILL_BETTER: PM ${polyStr} beats F402 ${f402Str}${keyTag}`;
      }

      return {
        gameId: r.game_id,
        period: r.period,
        subject: r.subject,
        marketKind: r.market_kind,
        side: r.side,
        polyTicket: r.poly_ticket,
        polyWallet: r.poly_wallet,
        polyLineHundredths: polyLine as LineHundredths | null,
        f402Ticket: r.f402_ticket,
        customerId: r.customer_id,
        agentId: r.agent_id,
        f402LineHundredths: f402Line as LineHundredths | null,
        deltaHundredths: sqlInt(r.delta_hundredths),
        betterVenue,
        keyNumberCrossed,
        isLayoffRisk,
        alertReason,
      };
    });
  }

  /**
   * Generates formatted terminal alert strings for mission-critical monitoring.
   */
  formatLayoffRiskAlerts(matches: readonly LineDeltaMatch[]): string[] {
    const alerts: string[] = [];
    for (const m of matches) {
      if (m.isLayoffRisk) {
        const shortWallet = m.polyWallet.length > 10 ? `${m.polyWallet.slice(0, 6)}...` : m.polyWallet;
        const polyLineStr = formatLineHundredths(m.polyLineHundredths);
        const f402LineStr = formatLineHundredths(m.f402LineHundredths);
        const keyTag = m.keyNumberCrossed ? ` [KEY ${m.keyNumberCrossed}]` : "";
        const perTag = m.period !== "game" ? ` (${m.period.toUpperCase()})` : "";
        alerts.push(
          `[ALERT] Layoff Risk: Wallet ${shortWallet} (PM ${polyLineStr}) beats pending TKT-${m.f402Ticket} (F402 ${f402LineStr}) on ${m.subject}${perTag} ${m.side}${keyTag} [Downline: ${m.agentId}/${m.customerId}]`,
        );
      }
    }
    return alerts;
  }

  /**
   * Computes top-line summary stats matching the dashboard metrics across CFB, NFL, and NBA.
   */
  computeSummary(matches: readonly LineDeltaMatch[]): CorrelationEngineSummary {
    const exactMatches = matches.filter((m) => m.deltaHundredths === 0).length;
    const adjacentMatches = matches.filter((m) => m.deltaHundredths > 0).length;
    const layoffRisks = matches.filter((m) => m.isLayoffRisk);

    const sgpRow = this.db
      .query(
        `SELECT COUNT(DISTINCT shape_sha256) as c
         FROM combo_observations_legs
         WHERE product_class IN ('sgp', 'parlay')`,
      )
      .get() as { c: number };

    const baylorRow = this.db
      .query(
        `SELECT COUNT(*) as c
         FROM combo_observations_legs
         WHERE subject = 'BAYLOR' AND source_venue = 'f402' AND status = 'pending'`,
      )
      .get() as { c: number };

    const nbaRow = this.db
      .query(
        `SELECT COUNT(*) as c
         FROM combo_observations_legs
         WHERE game_id LIKE 'NBA:%' AND source_venue = 'f402' AND status = 'pending'`,
      )
      .get() as { c: number };

    const troyRow = this.db
      .query(
        `SELECT COUNT(*) as c
         FROM combo_observations_legs
         WHERE subject = 'TROY' AND status = 'settled'`,
      )
      .get() as { c: number };

    const spRows = this.db
      .query(
        `SELECT
           CASE
            WHEN game_id LIKE 'CFB:%' THEN 'CFB'
            WHEN game_id LIKE 'NFL:%' THEN 'NFL'
            WHEN game_id LIKE 'NBA:%' THEN 'NBA'
            ELSE 'OTHER'
          END as sport,
          COALESCE(period, 'game') as period,
          COUNT(*) as pending_legs
         FROM combo_observations_legs
         WHERE source_venue = 'f402' AND status = 'pending'
         GROUP BY sport, period
         ORDER BY sport, period`,
      )
      .all() as Array<{ sport: string; period: string; pending_legs: number }>;

    const breakdown: SportPeriodBreakdown[] = spRows.map((r) => {
      const mCount = matches.filter(
        (m) => m.gameId.startsWith(`${r.sport}:`) && m.period === r.period,
      ).length;
      const lrCount = matches.filter(
        (m) => m.gameId.startsWith(`${r.sport}:`) && m.period === r.period && m.isLayoffRisk,
      ).length;
      return {
        sport: r.sport,
        period: r.period,
        pendingLegs: r.pending_legs,
        matchedLegs: mCount,
        layoffRisks: lrCount,
        polymarketEligible: r.period === "game",
      };
    });

    return {
      totalMatches: matches.length,
      exactMatches,
      adjacentMatches,
      sgpPairs: sgpRow?.c ?? 0,
      layoffRisks,
      baylorClusterCount: baylorRow?.c ?? 0,
      nbaClusterCount: nbaRow?.c ?? 0,
      settledTroyCount: troyRow?.c ?? 0,
      sportPeriodBreakdown: breakdown,
    };
  }
}
