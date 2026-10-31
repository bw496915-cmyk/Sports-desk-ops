# Real Ingestion — Polymarket + Fantasy402 (Phase 4)

Status: **partially implemented**. Polymarket positions are live (`--live`), F402 has a session
cache and a read-only `getBetTicker` probe (`--live-f402`), and pending-bet row mapping is still
fixture. This page states exactly what is verified.

## 1. Why

`docs/graph-live-feed.json` starts as a deterministic fixture: 39 configured wallet rows, 14
synthetic pending bets and a static $702,700 figure. With `--live`, the 23 valid wallet rows are
replaced by observed Polymarket positions; the 16 placeholder addresses are quarantined and
`pendingBets` stays fixture until its mapping is captured. Operators read the feed as telemetry, so
provenance is per wallet and a failure never silently looks live.

## 2. Sources and evidence level

| Source | Endpoint | Auth | Evidence |
| :--- | :--- | :--- | :--- |
| Polymarket positions | `GET https://data-api.polymarket.com/positions?user=<0x>&limit=500&offset=0` | none | **Live-verified** 2026-10-31: HTTP 200, 214 positions for `0x26cf…c612`, ~0.6 s |
| Polymarket CLOB WSS | `wss://ws-subscriptions-clob.polymarket.com/ws/...` | none | Not implemented here; see the shadow-stream runbooks |
| F402 `getPending` | `POST /cloud/api/Manager/getPending` | session cookie / JWT | **Tier C** — request and response uncaptured; content type disputed |
| F402 `getBetTicker` | `POST /cloud/api/Manager/getBetTicker` | session cookie / JWT | **Tier A** capture exists (2026-10-31) |

F402 auth is not a password grant. `scripts/evidence_capture.ts` logs in through a headless
`Bun.WebView`, reads HttpOnly cookies via CDP, and replays them in-process. A 60 s daemon cannot
launch a WebView per tick, so real F402 ingestion requires a **session cache** (below) and is not
shipped yet.

## 3. Feed contract changes

Top-level:

```jsonc
{
  "dataMode": "LIVE" | "PARTIAL" | "FIXTURE",
  "provenance": {
    "polymarket": {
      "source": "https://data-api.polymarket.com/positions",
      "walletsRequested": 39, "walletsOk": 23, "walletsFailed": 16,
      "walletsStale": 0, "walletsInvalid": 16,
      "fetchedAtIso": "…", "durationMs": 4120,
      "truncatedWallets": []
    },
    "f402": { "source": "fixture", "reason": "no session cache" }
  }
}
```

Per wallet, additive fields (existing keys stay):

```jsonc
{
  "dataSource": "LIVE" | "STALE" | "FIXTURE",
  "positionsValueUsd": 3576.39,
  "openPnlUsd": -872.95,
  "fetchedAtIso": "…",
  "staleSinceIso": "…",      // only when dataSource = STALE
  "openVolumeUsd": 24926,    // cost basis (sum initialValue)
  "openLegsCount": 214,      // non-redeemable positions
  "openBetsSummary": "…"     // top 3 by currentValue
}
```

`dataMode` is `PARTIAL` whenever any plane is live but pending bets are still fixture. `LIVE` is
reserved for the point where every wallet is fresh **and** F402 pending rows are mapped; that is not
reachable yet. `FIXTURE` means live ingest is off.

`openVolumeUsd` is **cost basis** (sum `initialValue`), `positionsValueUsd` is current mark
(sum `currentValue`), and `openPnlUsd` is `cashPnl`. `totalOpenExposureUsd` is the sum of current
position value, **not** defined liability. `wssIngestion: "not_ingested"` and
`wsStreamSlaMsFixture: 345` make the unmeasured WSS claim explicit; `activeSyndicateWalletsCount`
is the live-wallet count and `configuredWalletsCount` stays 39.

## 3.1 Wire → feed mapping

| Source shape | Canonical mapper | Feed / UI output | Status |
| :--- | :--- | :--- | :--- |
| F402 `RawPendingLegRow` (cents, UTC-5, per-leg) | `reconstructParentPendingTickets` (`simulate_bettor_churn_suite.ts`) → `ReconstructedTicket` (`ticketId`, `riskCents`, `winCents`, padded id, `is_live_wager`) | `pendingBets[].ticketId/riskUsd/toWinUsd` | **Gap** — no adapter; feed rows are hand-authored |
| F402 report leg (`AdjSpread`/`AdjTotalPoints`) | `mapF402ReportLeg` + `computeEffectiveLineHundredths` (`combo_identity.ts`) | Mode 7 `lineHundredths` | Implemented |
| F402 `RawBetTickerTick` (cents, UTC-5) | `parseF402TickerRow` (`lib/f402_ingest.ts`) | `liveTicks[]` identity/timing preview (no money) | Implemented preview; full money mapping needs units proof |
| Polymarket position | `parsePolymarketPosition` → `aggregatePositions` (`lib/polymarket_ingest.ts`) | `walletProfiles[].openVolumeUsd/openLegsCount/positionsValueUsd/openPnlUsd/openBetsSummary` | Implemented |
| GSLive account | `formatGsLivePlayerToken` / `formatGsLivePartnerUserId` | report `text=player_<LOGIN>`; bet-history `partnerUserId=<LOGIN>` | Implemented, documented in `report-surfaces.md` |
| 4-part identity | `gslive_manager_watchlist.ts` tuple | `customerLogin + agentId + gsLivePlayerId + proxyWallet` | Implemented, runbook §2.6 |

Timestamps: wire rows are UTC-5 (`InsertDateTime`), the feed uses UTC ISO, and desk-day windows use
`America/Chicago` via `resolveDeskDateYmd` / `computeDeskDayStartEpochSeconds`. Money: wire `Risk` /
`ToWin` are **cents**, the feed publishes **USD**; never mix them in one calculation.

## 4. Poll behavior

- 39 wallets, concurrency **6**, per-request timeout **10 s**, one retry on `429`/`5xx` after 250 ms.
- Pagination: `limit=500`, second page at `offset=500`; a third page is refused and the wallet is
  reported in `truncatedWallets` rather than silently under-counted.
- State cache: `scratch/graph-feed-state.json` (gitignored). On failure, the last good positions are
  reused and marked `dataSource: "STALE"` with `staleSinceIso`; the feed never downgrades to synthetic
  numbers for a wallet that was previously live.
- Cache writes are temp-file + rename; no secrets, only public positions.

## 5. Failure semantics

| Condition | Feed result |
| :--- | :--- |
| HTTP 200, valid array | `dataSource: "LIVE"` |
| Timeout / network / 5xx after retry | cached row → `STALE`; no cache → `FIXTURE` + `lastError` |
| 429 | retry once, then same as above |
| Non-array body | treated as failure; `lastError` includes the content type |
| Malformed position rows | row skipped, wallet counts only what parsed |

The poller exits 0 on partial failure (a single wallet outage must not stop the feed) but logs a
one-line summary: `ok=38 failed=1 stale=1`.

## 6. Security

- No credentials in the feed, logs, or cache. The F402 cookie, when added, lives in a 0600 file and is
  never echoed; only `cookieNames` may be logged.
- Polymarket requests are public and carry no identity.
- The live path is opt-in: `--live` or `SPORTSDESK_LIVE_INGEST=1`. CI and tests run fixtures only.

## 7. Rollout

1. **4a (shipped):** `--live` fetches Polymarket positions; wallet aggregates and summaries become
   observed; pending bets and F402 remain fixture and are labelled.
2. **4b (shipped as a preview):** F402 session cache — one WebView login (`F402_LIVE_LOGIN=1`),
   cookie file `0600` at `~/.cache/sportsdesk/f402-session.json` (override `F402_SESSION_FILE`),
   TTL 30 min (`F402_SESSION_TTL_MIN`), refresh once on 401. `getBetTicker` (tier A) rows are
   normalized into `liveTicks[]` (login, agent, writer, wager number, description, raw timestamp)
   and shown in the portal's Pending Bets tab. Money columns are withheld until their units are
   captured; `pendingBets` remains fixture and `mapped: false` is explicit. `getPending` stays out
   until a response is captured (tier C today).
3. **4c:** CLOB WSS stream replaces the 60 s positions poll for latency-sensitive rows.
4. Canary: run `--live` for one poll, diff wallet counts against the fixture, confirm no `NaN`/`null`
   leaks, then enable `SPORTSDESK_LIVE_INGEST=1` in the daemon.

### F402 command surface

```bash
# read-only probe with a cached session (login only if the cache is missing/expired)
F402_LIVE_LOGIN=1 ./bin/dx poll --live-f402

# both planes in one poll
./bin/dx poll --live --live-f402

# continuous daemon
SPORTSDESK_LIVE_INGEST=1 SPORTSDESK_LIVE_F402=1 ./bin/dx watch
```

`F402_OFFLINE_ONLY=1` disables the probe. The cache is refused when group/world-readable, expired,
or malformed; logs list cookie names only.

### Observed on the first live run (2026-10-31)

`--live` fetched 39 addresses in 1.24 s: **23 live, 16 failed**. All 16 failures are
`invalid address` — the fixture wallet table contains short/placeholder addresses such as
`0x9cD44e12A8b7F30192c44d8E11a08B3e7` (truncated) and `0x3af8…0000…1cfa` (synthetic). They stay
`dataSource: "FIXTURE"` and keep demo values, so totals are **partial**: 91 open legs and $205,332
current value across the 23 live wallets at that moment. Replace or remove the placeholders before
treating the totals as complete.

## 8. Non-goals

- No mutation calls (`updateByColumn`, `vigSetupInsert`) from the poller.
- No scraping of the GSLive SPA; only the public positions API is ingested.
- No automatic account enforcement based on live values.
