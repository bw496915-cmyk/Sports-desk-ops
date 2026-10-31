/**
 * @file lib/gslive_api_docs.ts
 * @description Single source for the GSLive Manager (Partner 118) documentation that ships in
 * `docs/openapi.json` (rendered by the Scalar portal) and `docs/api-reference.md`.
 *
 * These are operator deep links into a third-party console, not wire operations of our API.
 * They are published as `info.description` markdown plus a machine-readable
 * `x-sportsdesk-gslive` extension; the spec-level guard still forbids fabricated routes
 * (`ajax.php`) and forbids listing the GSLive host as an API server.
 */

import {
  GSLIVE_MANAGER_ORIGIN,
  GSLIVE_PARTNER_ID,
} from "./gslive_manager_watchlist.ts";
import {
  buildGsLiveBetHistorySidecarUrl,
  buildGsLiveUsersReportDeepLink,
} from "./gslive_manager_deeplink_sidecar.ts";

/** Illustrative fixed window/tick — real links roll with the desk day. */
const EXAMPLE_REPORT = buildGsLiveUsersReportDeepLink({
  customerLogin: "CHURN_003",
  bot: true,
  eventId: "",
  fromIsoUtc: "2026-10-18T05:00:00.000Z",
  toIsoUtc: "2026-10-26T04:59:59.000Z",
  partnerId: 118,
  searchBy: "player",
});
const EXAMPLE_CALC = buildGsLiveBetHistorySidecarUrl({
  dateYmd: "2026-10-31",
  dateFilterBy: "calcTime",
  tickEpochMs: 1793469958152,
});
const EXAMPLE_BET = buildGsLiveBetHistorySidecarUrl({
  dateYmd: "2026-10-31",
  dateFilterBy: "betTime",
  tickEpochMs: 1793469958152,
});
const EXAMPLE_CALC_PLAYER = buildGsLiveBetHistorySidecarUrl({
  dateYmd: "2026-10-31",
  dateFilterBy: "calcTime",
  tickEpochMs: 1793469958152,
  customerLogin: "CHURN_003",
});

export const GSLIVE_OPENAPI_EXTENSION = {
  "x-sportsdesk-gslive": {
    provider: "GSLive Manager (Partner 118)",
    kind: "operator-deep-links-not-wire-operations",
    origin: GSLIVE_MANAGER_ORIGIN,
    managerPath: "/manager-tools/",
    partnerId: Number(GSLIVE_PARTNER_ID),
    cli: "./bin/dx gslive <LOGIN>",
    contractDoc: "docs/gs-manager-contracts.md",
    surfaces: [
      {
        id: "users-report",
        route: "#/reports/users",
        purpose:
          "Per-account batch report (profit, bets, hold %, wager and leg counts).",
        windows: ["today", "7d", "14d", "churn"],
        requiredQuery: {
          bot: "true",
          eventId: "",
          from: "<desk-day start, ISO-8601 UTC>",
          partnerId: "118",
          searchBy: "player",
          text: "player_<LOGIN>",
          to: "<desk-day end, ISO-8601 UTC>",
        },
        notes: [
          "bot=true is mandatory; the SPA defaults the bot switch off and hides syndicate accounts.",
          "from/to must be explicit desk-day boundaries; a bare text search renders an empty grid.",
        ],
        example: EXAMPLE_REPORT,
      },
      {
        id: "bet-history-calctime",
        route: "#/events/bet-history",
        purpose: "Live settling/populating ticket stream (calcTime).",
        requiredQuery: {
          minVolume: "0",
          maxTimeUntilScore: "0",
          from: "<desk-day start, epoch seconds>",
          to: "<desk-day start, epoch seconds>",
          toTime: "<desk day length - 1: 86399, or 89999/82799 on DST days>",
          dateFilterBy: "calcTime",
          t: "<epoch milliseconds cache-buster>",
        },
        notes: [
          "partnerUserId is the raw login (e.g. AF12), not player_AF12; it is still unverified as a server-side filter in the SPA router.",
          "t must be refreshed on every open; a frozen value serves a cached grid.",
        ],
        example: EXAMPLE_CALC,
      },
      {
        id: "bet-history-bettime",
        route: "#/events/bet-history",
        purpose: "Live placement stream (betTime).",
        requiredQuery: {
          minVolume: "0",
          maxTimeUntilScore: "0",
          from: "<desk-day start, epoch seconds>",
          to: "<desk-day start, epoch seconds>",
          toTime: "<desk day length - 1: 86399, or 89999/82799 on DST days>",
          dateFilterBy: "betTime",
          t: "<epoch milliseconds cache-buster>",
        },
        notes: ["Same day window as calcTime; only dateFilterBy differs."],
        example: EXAMPLE_BET,
      },
    ],
  },
} as const;

/**
 * Markdown block embedded in `info.description` and appended to `docs/api-reference.md`.
 * Keep it self-contained and honest: no endpoint is claimed to exist on our servers.
 */
export function renderGSLiveDocsMarkdown(): string {
  return [
    "## GSLive Manager (Partner 118): operator deep links",
    "",
    "GSLive is a third-party operator console, **not** a server of this API. The links below are",
    "deep links an operator opens in a browser; they carry no request contract of ours. Every",
    "per-account link is produced by `lib/gslive_manager_deeplink_sidecar.ts` and can be generated",
    "with `./bin/dx gslive <LOGIN>`.",
    "",
    "| Surface | Route | What it answers |",
    "| :--- | :--- | :--- |",
    "| Account report (batch) | `#/reports/users` | Profit, bets, hold %, wager and leg counts for one `player_<LOGIN>` over a day window. |",
    "| Live settling stream (`calcTime`) | `#/events/bet-history` | Tickets as they settle/populate for the current desk day. |",
    "| Live placement stream (`betTime`) | `#/events/bet-history` | Tickets as they are placed. |",
    "",
    "### Account report rules",
    "",
    "- `bot=true` is mandatory. The SPA defaults the bot switch off, which hides syndicate accounts such as `player_CHURN_003` and `player_NOISE_BOT_77`.",
    "- `from` and `to` must be explicit ISO-8601 UTC desk-day boundaries (`00:00:00` to `23:59:59` in `America/Chicago`). A bare `text=` search renders an empty grid.",
    "- `searchBy=player` and `text=player_<LOGIN>`; `partnerId=118`.",
    "",
    "Example (fixed churn window; the CLI emits today's rolling window):",
    "",
    "```text",
    EXAMPLE_REPORT,
    "```",
    "",
    "### Live bet-history rules",
    "",
    "- `from` and `to` are the desk-day start in **epoch seconds**; `toTime` is the offset to the last second of that day (`86399`, or `89999`/`82799` on US DST transition days).",
    "- `minVolume=0` and `maxTimeUntilScore=0` disable volume/score-time filtering so live tickets appear immediately.",
    "- `t` is an epoch-millisecond cache-buster and must be fresh on every open.",
    "- `dateFilterBy=calcTime` follows settlement; `dateFilterBy=betTime` follows placement.",
    "- `partnerUserId=<LOGIN>` (raw login, e.g. `AF12`) filters to one player; the live console emits the unprefixed form. It is **unverified** as a server-side filter — confirm by row count, and if the grid is not filtered, filter in the console.",
    "",
    "```text",
    EXAMPLE_CALC,
    EXAMPLE_BET,
    "```",
    "",
    "Per-player variant (adds `partnerUserId`):",
    "",
    "```text",
    EXAMPLE_CALC_PLAYER,
    "```",
    "",
    "### Related documentation",
    "",
    "- `docs/gs-manager-contracts.md` — observed payloads and open questions.",
    "- `docs/OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md` — which surface to use for Modes 1, 6, 7, 8, 9 and 10.",
    "",
  ].join("\n");
}
