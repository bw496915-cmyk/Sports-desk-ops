/**
 * @file lib/gslive_manager_deeplink_sidecar.ts
 * @description Canonical GSLive Manager (`https://plive.sportswidgets.pro/manager-tools/`)
 *              7-Parameter `#/reports/users` Deep-Link Builder & `#/events/bet-history` Live Event Sidecar.
 *
 * Solves two distinct operator visibility gaps in GSLive Manager (Partner 118):
 *
 * 1. Why naive `#/reports/users` links fail to show rows (and how the 7-parameter deep link fixes it):
 *    - Naive link: `#/reports/users?partnerId=118&searchBy=player&text=player_CHURN_003`
 *    - Problem A (`bot` filter): The SPA defaults to `bot=false` ("Bot report: No"), which hides
 *      syndicate/automated/bot-flagged accounts (`player_CHURN_003`, `player_MJ102`, `player_NOISE_BOT_77`).
 *      Passing `bot=true` forces the Bot switch ON.
 *    - Problem B (`from` / `to` UTC CDT day-boundary ISO strings & `eventId=`): Without explicit
 *      `05:00:00.000Z` (00:00:00 CDT, UTC-5) to `04:59:59.000Z` (23:59:59 CDT) ISO bounds and `eventId=`,
 *      the SPA initializes an empty or stale single-day window (`Total records: 0`).
 *    - Canonical 7-Parameter Deep Link:
 *      `https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-18T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_CHURN_003&to=2026-10-26T04%3A59%3A59.000Z`
 *
 * 2. Why you ALSO need the `#/events/bet-history` Live Sidecar (`calcTime` / `betTime`):
 *    - `#/reports/users` is an account-level aggregate report with batch lag (`Last data update`).
 *    - `#/events/bet-history` (which backs `action: "getBetReport"`) is the real-time event/ticket stream.
 *    - Canonical Live Sidecar URL:
 *      `https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793422800&to=1793422800&toTime=86399&dateFilterBy=calcTime&t=1793469958152`
 *      where:
 *        • `from=1793422800` & `to=1793422800` = `2026-10-31T05:00:00.000Z` (`00:00:00 CDT` start of day in epoch seconds)
 *        • `toTime=86399` = `+23h 59m 59s` (`23:59:59 CDT` end of day)
 *        • `minVolume=0` & `maxTimeUntilScore=0` = zero volume/score-time filtering so all live wagers appear immediately
 *        • `dateFilterBy=calcTime` (live settling/populating events) or `betTime` (live placement stream)
 *        • `t=<epochMs>` = monotonic cache-buster timestamp updated on every 60s `Bun.cron` / 15s UI poll tick.
 */

export const GSLIVE_MANAGER_BASE_URL = "https://plive.sportswidgets.pro/manager-tools/";

export interface GsLiveUsersReportDeepLinkOptions {
  readonly customerLogin: string; // e.g., "CHURN_003", "MJ102", "player_CHURN_003"
  readonly bot?: boolean; // default: true (critical so bot/syndicate accounts are not hidden!)
  readonly eventId?: string; // default: ""
  readonly fromIsoUtc?: string; // default: "2026-10-18T05:00:00.000Z" (00:00:00 CDT)
  readonly toIsoUtc?: string; // default: "2026-11-01T04:59:59.000Z" (23:59:59 CDT)
  readonly partnerId?: string | number; // default: 118
  readonly searchBy?: "player" | "agent"; // default: "player"
}

export interface GsLiveBetHistorySidecarOptions {
  readonly minVolume?: number; // default: 0
  readonly maxTimeUntilScore?: number; // default: 0
  readonly fromEpochSec?: number; // default: 1793422800 (2026-10-31T05:00:00.000Z = 00:00:00 CDT)
  readonly toEpochSec?: number; // default: 1793422800
  readonly toTimeSec?: number; // default: 86399 (23:59:59 end-of-day offset)
  readonly dateFilterBy?: "calcTime" | "betTime"; // default: "calcTime"
  readonly tickEpochMs?: number; // default: 1793469958152 or Date.now()
  readonly customerLogin?: string; // optional per-player filter
  readonly eventId?: string; // optional eventId filter
}

/**
 * Normalizes any Fantasy402 login or `player_` string to the canonical `player_<UPPERCASE_ID>` format.
 */
export function formatGsLivePlayerToken(rawLogin: string): string {
  const clean = rawLogin
    .trim()
    .replace(/^player_/i, "")
    .replace(/\s+/g, "")
    .replace(/^\.|\.$/g, "")
    .toUpperCase();
  return `player_${clean}`;
}

/**
 * Computes the UTC epoch seconds for `00:00:00 CDT` (`05:00:00.000Z`) for a given `YYYY-MM-DD` date.
 * For `2026-10-31`, returns `1793422800`.
 */
export function computeCdtDayStartEpochSeconds(dateYmd = "2026-10-31"): number {
  const parts = dateYmd.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return 1793422800;
  }
  return Math.floor(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, 5, 0, 0, 0) / 1000);
}

/**
 * Builds the exact 7-parameter `#/reports/users` deep link matching GSLive Manager's router state:
 * `https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-18T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_CHURN_003&to=2026-10-26T04%3A59%3A59.000Z`
 */
export function buildGsLiveUsersReportDeepLink(
  options: GsLiveUsersReportDeepLinkOptions
): string {
  const bot = options.bot ?? true;
  const eventId = options.eventId ?? "";
  const fromIso = options.fromIsoUtc ?? "2026-10-18T05:00:00.000Z";
  const toIso = options.toIsoUtc ?? "2026-11-01T04:59:59.000Z";
  const partnerId = String(options.partnerId ?? 118);
  const searchBy = options.searchBy ?? "player";
  const playerText =
    searchBy === "player"
      ? formatGsLivePlayerToken(options.customerLogin)
      : options.customerLogin.trim().toUpperCase();

  // Preserve exact key order and %3A encoding expected by GSLive Manager SPA router
  const query = [
    `bot=${bot ? "true" : "false"}`,
    `eventId=${encodeURIComponent(eventId)}`,
    `from=${encodeURIComponent(fromIso)}`,
    `partnerId=${encodeURIComponent(partnerId)}`,
    `searchBy=${encodeURIComponent(searchBy)}`,
    `text=${encodeURIComponent(playerText)}`,
    `to=${encodeURIComponent(toIso)}`,
  ].join("&");

  return `${GSLIVE_MANAGER_BASE_URL}#/reports/users?${query}`;
}

/**
 * Builds the `#/events/bet-history` Live Populating Stream Sidecar URL:
 * `https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793422800&to=1793422800&toTime=86399&dateFilterBy=calcTime&t=1793469958152`
 */
export function buildGsLiveBetHistorySidecarUrl(
  options?: GsLiveBetHistorySidecarOptions
): string {
  const minVolume = options?.minVolume ?? 0;
  const maxTimeUntilScore = options?.maxTimeUntilScore ?? 0;
  const fromEpoch = options?.fromEpochSec ?? 1793422800;
  const toEpoch = options?.toEpochSec ?? fromEpoch;
  const toTime = options?.toTimeSec ?? 86399;
  const dateFilterBy = options?.dateFilterBy ?? "calcTime";
  const tickMs = options?.tickEpochMs ?? 1793469958152;

  const params: string[] = [
    `minVolume=${minVolume}`,
    `maxTimeUntilScore=${maxTimeUntilScore}`,
    `from=${fromEpoch}`,
    `to=${toEpoch}`,
    `toTime=${toTime}`,
    `dateFilterBy=${encodeURIComponent(dateFilterBy)}`,
    `t=${tickMs}`,
  ];

  if (options?.customerLogin) {
    params.push(`partnerUserId=${encodeURIComponent(formatGsLivePlayerToken(options.customerLogin))}`);
  }
  if (options?.eventId) {
    params.push(`eventId=${encodeURIComponent(options.eventId)}`);
  }

  return `${GSLIVE_MANAGER_BASE_URL}#/events/bet-history?${params.join("&")}`;
}

export interface GsLiveDualSurfaceDescriptor {
  readonly customerLogin: string;
  readonly gsLivePlayerId: string;
  readonly usersReportDeepLink7Day: string;
  readonly usersReportDeepLink14Day: string;
  readonly usersReportChurnWindowDeepLink: string;
  readonly liveBetHistorySidecarCalcTimeUrl: string;
  readonly liveBetHistorySidecarBetTimeUrl: string;
  readonly playerBetHistoryDeepLinkUrl: string;
  readonly getBetReportObservedPayload: {
    readonly action: "getBetReport";
    readonly partnerUserId: string;
    readonly agent: string;
    readonly eventId: string;
    readonly freeBetId: string;
    readonly state: string;
    readonly sId: "2";
    readonly minVolume: "0";
    readonly maxTimeUntilScore: "0";
    readonly mId: string;
    readonly from: number;
    readonly fromTime: 0;
    readonly to: number;
    readonly toTime: 86399;
    readonly betId: string;
    readonly betGroupId: string;
    readonly group: null;
    readonly dateFilterBy: "calcTime" | "betTime";
    readonly partnerIds: string;
    readonly period: "s3";
  };
}

/**
 * Builds the complete Dual-Surface GSLive descriptor for any account (e.g., `CHURN_003`, `MJ102`, `BGD101`),
 * combining the 7-parameter `#/reports/users` deep links with the `#/events/bet-history` live sidecar URLs.
 */
export function buildGsLiveDualSurfaceDescriptor(
  customerLogin: string,
  options?: {
    dateYmd?: string;
    tickEpochMs?: number;
  }
): GsLiveDualSurfaceDescriptor {
  const gsLivePlayerId = formatGsLivePlayerToken(customerLogin);
  const cleanLogin = gsLivePlayerId.replace(/^player_/, "");
  const dayStartEpoch = computeCdtDayStartEpochSeconds(options?.dateYmd ?? "2026-10-31");
  const tickMs = options?.tickEpochMs ?? 1793469958152;

  return {
    customerLogin: cleanLogin,
    gsLivePlayerId,
    usersReportDeepLink7Day: buildGsLiveUsersReportDeepLink({
      customerLogin: cleanLogin,
      bot: true,
      eventId: "",
      fromIsoUtc: "2026-10-25T05:00:00.000Z",
      toIsoUtc: "2026-11-01T04:59:59.000Z",
      partnerId: 118,
      searchBy: "player",
    }),
    usersReportDeepLink14Day: buildGsLiveUsersReportDeepLink({
      customerLogin: cleanLogin,
      bot: true,
      eventId: "",
      fromIsoUtc: "2026-10-18T05:00:00.000Z",
      toIsoUtc: "2026-11-01T04:59:59.000Z",
      partnerId: 118,
      searchBy: "player",
    }),
    usersReportChurnWindowDeepLink: buildGsLiveUsersReportDeepLink({
      customerLogin: cleanLogin,
      bot: true,
      eventId: "",
      fromIsoUtc: "2026-10-18T05:00:00.000Z",
      toIsoUtc: "2026-10-26T04:59:59.000Z",
      partnerId: 118,
      searchBy: "player",
    }),
    liveBetHistorySidecarCalcTimeUrl: buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      fromEpochSec: dayStartEpoch,
      toEpochSec: dayStartEpoch,
      toTimeSec: 86399,
      dateFilterBy: "calcTime",
      tickEpochMs: tickMs,
    }),
    liveBetHistorySidecarBetTimeUrl: buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      fromEpochSec: dayStartEpoch,
      toEpochSec: dayStartEpoch,
      toTimeSec: 86399,
      dateFilterBy: "betTime",
      tickEpochMs: tickMs,
    }),
    playerBetHistoryDeepLinkUrl: buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      fromEpochSec: dayStartEpoch,
      toEpochSec: dayStartEpoch,
      toTimeSec: 86399,
      dateFilterBy: "calcTime",
      tickEpochMs: tickMs,
      customerLogin: cleanLogin,
    }),
    getBetReportObservedPayload: {
      action: "getBetReport",
      partnerUserId: "",
      agent: "",
      eventId: "",
      freeBetId: "",
      state: "",
      sId: "2",
      minVolume: "0",
      maxTimeUntilScore: "0",
      mId: "",
      from: dayStartEpoch,
      fromTime: 0,
      to: dayStartEpoch + 86399,
      toTime: 86399,
      betId: "",
      betGroupId: "",
      group: null,
      dateFilterBy: "calcTime",
      partnerIds: "",
      period: "s3",
    },
  };
}
