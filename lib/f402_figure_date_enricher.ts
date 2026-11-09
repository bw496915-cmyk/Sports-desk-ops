/**
 * @file lib/f402_figure_date_enricher.ts
 * @description Ingestion and enrichment pipeline connecting the live bet ticker (f402-bets.jsonl)
 * with settled ground-truth records from /cloud/api/Report/getWagersByFigureDate.
 *
 * Joins real-time risk intake with settled outcomes, native team opponents, canonical EventIDs,
 * deterministic SubSports, native line values, and execution-latency metrics.
 */

import {
  classifyPortalPeriod,
  type PortalPeriodCode,
} from "./portal_period_taxonomy.ts";
import { sportCategoryFor } from "./sport_taxonomy.ts";

export interface FigureDateWager {
  readonly TicketNumber: number | string;
  readonly WagerNumber: number;
  readonly PlayNumber?: number;
  readonly AmountWagered: number;
  readonly ToWinAmount: number;
  readonly WagerType: string;
  readonly AmountWon: number;
  readonly AmountLost: number;
  readonly WagerStatus: string;
  readonly Outcome?: string;
  readonly Description: string;
  readonly AcceptedDateTime: string;
  readonly CustomerID: string;
  readonly TicketWriter: string;
  readonly GameDateTime: string;
  readonly SportType: string;
  readonly SportSubType: string;
  readonly AdjSpread?: number;
  readonly AdjTotalPoints?: number;
  readonly TotalPointsOU?: string;
  readonly FinalMoney?: number;
  readonly GradeMoney?: number;
  readonly ChosenTeamID?: string;
  readonly PeriodDescription?: string;
  readonly Team1ID?: string;
  readonly Team1FinalScore?: number;
  readonly Team2ID?: string;
  readonly Team2FinalScore?: number;
  readonly PeriodNumber?: number;
  readonly DailyFigureDate?: string;
  readonly FinalDecimal?: number;
  readonly OrigSpread?: number;
  readonly OrigTotalPoints?: number;
  readonly BuyPoints?: number;
  readonly TotalPicks?: number;
  readonly totalPicks?: number;
  readonly PlacedOn?: string;
  readonly Team1RotNum?: number;
  readonly Team2RotNum?: number;
  readonly Comments?: string;
  [key: string]: unknown;
}

export interface LiveTickerWager {
  readonly WagerNumber: number;
  readonly AgentID?: string;
  readonly AgentLogin?: string;
  readonly CustomerID: string;
  readonly Login?: string;
  readonly WagerType: string;
  readonly AmountWagered: number;
  readonly ToWinAmount: number;
  readonly VolumeAmount?: number;
  readonly InsertDateTime: string;
  readonly TicketWriter: string;
  readonly ShortDesc: string;
  readonly VIP?: string;
  readonly capturedAtMs?: number;
  readonly isFirstObservation?: boolean;
  [key: string]: unknown;
}

export interface EnrichedWager {
  readonly ticketNumber: string;
  readonly liveWagerNumber: number;
  readonly customerId: string;
  readonly agentLogin: string;
  readonly ticketWriter: string;
  readonly volumeAmount: number;
  readonly totalPicks: number;
  readonly eventId: string;
  readonly sport: string;
  readonly subSport: string;
  readonly opponents: {
    readonly away: string;
    readonly home: string;
  };
  readonly gameDateTime: string;
  readonly acceptedDateTime: string;
  readonly dailyFigureDate: string;
  readonly latencySeconds: number;
  readonly isLateSteam: boolean;
  readonly isLive: boolean;
  readonly portalPeriod: PortalPeriodCode | null;
  readonly periodDescription: string;
  readonly periodNumber: number;
  readonly marketType:
    "spread" | "total" | "moneyline" | "derivative_points" | "other";
  readonly buyPoints: number;
  readonly origSpread?: number | null;
  readonly adjSpread?: number | null;
  readonly origTotalPoints?: number | null;
  readonly adjTotalPoints?: number | null;
  readonly selection: {
    readonly chosenTeam: string;
    readonly line: number | null;
    readonly origLine: number | null;
    readonly buyPoints: number;
    readonly price: number | null;
    readonly overUnder?: "O" | "U" | null;
  };
  readonly settlement: {
    readonly isSettled: boolean;
    readonly status: string;
    readonly outcome: string;
    readonly amountWageredCents: number;
    readonly toWinCents: number;
    readonly amountWonCents: number;
    readonly amountLostCents: number;
    readonly netPnlCents: number;
    readonly awayScore: number | null;
    readonly homeScore: number | null;
  };
}

/**
 * Builds a deterministic composite matching signature for reconciliation.
 *
 * Since the live ticker numbers transactions under an internal sequence (WagerNumber)
 * while the settlement API reports customer TicketNumber, we match on the deterministic tuple:
 * (CustomerID, PlacedMinute, AmountWagered, ToWinAmount, RotationNum).
 */
export function buildCompositeMatchKey(
  customerId: string,
  dateTimeStr: string,
  amountWagered: number,
  toWinAmount: number,
  desc: string,
): string {
  const normCust = customerId.trim().toUpperCase();
  // Strip sub-seconds: "2026-11-06 20:09:35.080" -> "2026-11-06 20:09"
  const minuteKey = dateTimeStr.slice(0, 16);
  // Extract rotation number if present: "#546" -> "546"
  const rotMatch = desc.match(/#(\d+)/);
  const rot = rotMatch ? rotMatch[1] : "NOROT";

  return `${normCust}|${minuteKey}|${amountWagered}|${toWinAmount}|${rot}`;
}

/**
 * Canonicalizes team strings for event identification:
 * 1. Normalizes "Saint " to "St."
 * 2. Normalizes "St " (without period) to "St."
 * 3. Collapses whitespace while preserving punctuation (periods, apostrophes, hyphens).
 *
 * Examples:
 *  - "St. Louis Blues"     -> "St.LouisBlues"
 *  - "St Louis Blues"      -> "St.LouisBlues"
 *  - "Saint Louis Blues"   -> "St.LouisBlues"
 *  - "Tampa Bay Lightning" -> "TampaBayLightning"
 */
export function canonicalTeamToken(team: string): string {
  if (!team) return "";
  let token = team.trim();
  token = token.replace(/\bSaint\s+/i, "St. ");
  token = token.replace(/\bSt\s+(?=[A-Za-z])/i, "St. ");
  return token.replace(/\s+/g, "");
}

/**
 * Builds the canonical EventID: {SubSport}-{YYYYMMDD}-{Away}@{Home}
 */
export function buildCanonicalEventId(
  subSport: string,
  gameDateTime: string,
  team1: string,
  team2: string,
): string {
  const cleanSub = subSport.trim().replace(/\s+/g, "_");
  const dateStr = gameDateTime.slice(0, 10).replace(/-/g, "");
  const cleanTeam1 = canonicalTeamToken(team1);
  const cleanTeam2 = canonicalTeamToken(team2);

  if (!cleanTeam1 && !cleanTeam2) {
    return `${cleanSub}-${dateStr}-UNRESOLVED`;
  }
  return `${cleanSub}-${dateStr}-${cleanTeam1}@${cleanTeam2}`;
}

/**
 * Categorizes market type without ever using the forbidden phrase.
 */
export function inferMarketType(
  wagerType: string,
  desc: string,
  adjSpread?: number,
  adjTotal?: number,
): "spread" | "total" | "moneyline" | "derivative_points" | "other" {
  if (wagerType === "E" || /derivative|individual\s*points/i.test(desc)) {
    return "derivative_points";
  }
  if (adjSpread !== undefined && adjSpread !== 0) {
    return "spread";
  }
  if (adjTotal !== undefined && adjTotal !== 0) {
    return "total";
  }
  if (/Winner\s*\(2\s*way\)|Money\s*Line|ML/i.test(desc) || wagerType === "M") {
    return "moneyline";
  }
  return "other";
}

/**
 * Extracts point purchases from wager descriptions (e.g. "- buying ½ For Game").
 */
export function parseBuyPointsFromDesc(desc: string): number {
  if (!desc) return 0;
  const match = desc.match(
    /buying\s+((?:[½¼¾\d.\s]|&#189;|&frac12;|&#188;|&frac14;|&#190;|&frac34;)+)/i,
  );
  if (!match) return 0;
  const raw =
    match[1]
      ?.replace(/&#189;|&frac12;/g, "½")
      .replace(/&#188;|&frac14;/g, "¼")
      .replace(/&#190;|&frac34;/g, "¾")
      .trim() ?? "";
  if (raw === "½") return 0.5;
  if (raw === "1½" || raw === "1 ½") return 1.5;
  if (raw === "2½" || raw === "2 ½") return 2.5;
  if (raw === "¼") return 0.25;
  if (raw === "¾") return 0.75;
  const num = parseFloat(
    raw.replace("½", ".5").replace("¼", ".25").replace("¾", ".75"),
  );
  return Number.isFinite(num) ? num : 0;
}

/**
 * Infers the number of picks/legs on a wager from its wager type and description.
 * Straight bets (S, M, L, E) are always 1 pick; multi-leg bets (P, T, R, I) count legs.
 */
export function inferTotalPicks(wagerType?: string, desc?: string): number {
  const wt = (wagerType || "").trim().toUpperCase();
  if (
    wt === "S" ||
    wt === "M" ||
    wt === "L" ||
    wt === "E" ||
    wt === "A" ||
    wt === "C"
  ) {
    return 1;
  }
  if (!desc) {
    return wt === "P" || wt === "T" || wt === "R" || wt === "I" ? 2 : 1;
  }

  // Check for sport rotation tokens (e.g. Football #101, LIVE #9101)
  const matches = desc.match(
    /(?:Football|Basketball|Baseball|Hockey|Soccer|Tennis|Golf|LIVE)\s+#/gi,
  );
  if (matches && matches.length > 1) {
    return matches.length;
  }
  // Check for multiple matchup lines (e.g. in GSBUILDER: "vs" or " / ")
  const lines = desc
    .split(/[\r\n]+/)
    .filter((l) => l.includes(" vs ") || l.includes(" / "));
  if (lines.length > 1) {
    return lines.length;
  }
  return wt === "P" || wt === "T" || wt === "R" || wt === "I" ? 2 : 1;
}

/**
 * Calculates execution latency in seconds from bet placement to scheduled start.
 * Negative or near-zero latency signals steam chasing or late-clock execution.
 */
export function computeExecutionLatency(
  placedAtIso: string,
  gameTimeIso: string,
): number {
  const placedMs = new Date(placedAtIso.replace(" ", "T")).getTime();
  const gameMs = new Date(gameTimeIso.replace(" ", "T")).getTime();
  if (isNaN(placedMs) || isNaN(gameMs)) {
    return 0;
  }
  return Math.round((gameMs - placedMs) / 1000);
}

/**
 * Enriches a live ticker row using settled ground truth from getWagersByFigureDate.
 */
export function enrichWagerRecord(
  ticker: LiveTickerWager,
  figure: FigureDateWager,
): EnrichedWager {
  const rawSport = (figure.SportType || "Unknown").trim();
  const subSport = (figure.SportSubType || "Unknown").trim();
  const canonicalCategory = sportCategoryFor({
    sportType: figure.SportType,
    sportSubType: figure.SportSubType,
  });
  const sport = canonicalCategory !== "Other" ? canonicalCategory : rawSport;
  const team1 = (figure.Team1ID || "").trim();
  const team2 = (figure.Team2ID || "").trim();
  const gameTime = (figure.GameDateTime || ticker.InsertDateTime).trim();
  const acceptedTime = (
    figure.AcceptedDateTime || ticker.InsertDateTime
  ).trim();

  const latencySeconds = computeExecutionLatency(acceptedTime, gameTime);
  const isLateSteam = latencySeconds >= 0 && latencySeconds <= 120; // placed within 2 minutes of start

  const periodClassification = classifyPortalPeriod({
    Period: figure.PeriodDescription ?? "",
    Description: figure.Description ?? "",
    ShortDesc: ticker.ShortDesc ?? "",
    WagerType: figure.WagerType || ticker.WagerType,
  });

  const marketType = inferMarketType(
    figure.WagerType || ticker.WagerType,
    figure.Description || ticker.ShortDesc,
    figure.AdjSpread,
    figure.AdjTotalPoints,
  );

  const amountWon = Number(figure.AmountWon || 0);
  const amountLost = Number(figure.AmountLost || 0);
  const netPnl = amountWon - amountLost;

  const buyPoints =
    figure.BuyPoints !== undefined &&
    figure.BuyPoints !== null &&
    Number(figure.BuyPoints) > 0
      ? Number(figure.BuyPoints)
      : parseBuyPointsFromDesc(ticker.ShortDesc || figure.Description || "");

  const origLine =
    marketType === "total"
      ? (figure.OrigTotalPoints ?? figure.AdjTotalPoints ?? null)
      : figure.OrigSpread !== undefined && figure.OrigSpread !== 0
        ? figure.OrigSpread
        : (figure.AdjSpread ?? null);

  const rawPicks = figure.TotalPicks ?? figure.totalPicks;
  const totalPicks =
    rawPicks !== undefined && rawPicks !== null && Number(rawPicks) > 0
      ? Number(rawPicks)
      : inferTotalPicks(
          figure.WagerType || ticker.WagerType,
          ticker.ShortDesc || figure.Description,
        );

  return {
    ticketNumber: String(figure.TicketNumber || ticker.WagerNumber),
    liveWagerNumber: ticker.WagerNumber,
    customerId: ticker.CustomerID.trim(),
    agentLogin: (ticker.AgentLogin || ticker.AgentID || "").trim(),
    ticketWriter: (figure.TicketWriter || ticker.TicketWriter).trim(),
    volumeAmount: Number(ticker.VolumeAmount ?? ticker.AmountWagered ?? 0),
    totalPicks,
    eventId: buildCanonicalEventId(subSport, gameTime, team1, team2),
    sport,
    subSport,
    opponents: {
      away: team1,
      home: team2,
    },
    gameDateTime: gameTime,
    acceptedDateTime: acceptedTime,
    dailyFigureDate: (figure.DailyFigureDate
      ? String(figure.DailyFigureDate).slice(0, 10)
      : acceptedTime.slice(0, 10)
    ).trim(),
    latencySeconds,
    isLateSteam,
    isLive:
      sport.toUpperCase() === "LIVE" ||
      subSport.toUpperCase().includes("LIVE") ||
      /LIVE/i.test(ticker.ShortDesc ?? ""),
    portalPeriod:
      figure.PeriodNumber !== undefined &&
      figure.PeriodNumber >= -1 &&
      figure.PeriodNumber <= 6
        ? (figure.PeriodNumber as PortalPeriodCode)
        : periodClassification.portalPeriod,
    periodNumber:
      figure.PeriodNumber !== undefined && figure.PeriodNumber !== null
        ? Number(figure.PeriodNumber)
        : (periodClassification.portalPeriod ?? 0),
    periodDescription: (
      figure.PeriodDescription || periodClassification.portalLabel
    ).trim(),
    marketType,
    buyPoints,
    origSpread: figure.OrigSpread ?? null,
    adjSpread: figure.AdjSpread ?? null,
    origTotalPoints: figure.OrigTotalPoints ?? null,
    adjTotalPoints: figure.AdjTotalPoints ?? null,
    selection: {
      chosenTeam: (figure.ChosenTeamID || "").trim(),
      line:
        marketType === "total"
          ? (figure.AdjTotalPoints ?? figure.AdjSpread ?? null)
          : figure.AdjSpread !== undefined && figure.AdjSpread !== 0
            ? figure.AdjSpread
            : (figure.AdjTotalPoints ?? figure.AdjSpread ?? null),
      origLine,
      buyPoints,
      price: figure.FinalMoney ?? figure.GradeMoney ?? null,
      overUnder:
        figure.TotalPointsOU?.trim() === "O" ||
        figure.TotalPointsOU?.trim() === "U"
          ? (figure.TotalPointsOU.trim() as "O" | "U")
          : null,
    },
    settlement: {
      isSettled: figure.WagerStatus !== "P" && figure.WagerStatus !== "O",
      status: figure.WagerStatus || "P",
      outcome: figure.Outcome || figure.WagerStatus || "PENDING",
      amountWageredCents: Number(
        figure.AmountWagered || ticker.AmountWagered || 0,
      ),
      toWinCents: Number(figure.ToWinAmount || ticker.ToWinAmount || 0),
      amountWonCents: amountWon,
      amountLostCents: amountLost,
      netPnlCents: netPnl,
      awayScore: figure.Team1FinalScore ?? null,
      homeScore: figure.Team2FinalScore ?? null,
    },
  };
}
