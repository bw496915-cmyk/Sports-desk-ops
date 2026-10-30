# Surface inventory — D/E ledger rows

Companion to [ledger.json](./ledger.json). Two kinds of surface are missing from the published spec:

- **D — real surface, absent from `docs/openapi.json`.** The surface exists in code, fixtures or an
  external deliverable, but the 47-path / 48-operation spec has no row for it.
- **E — documented, not implemented.** The spec publishes an operation that no code in this repo serves.

Every `id` below is the same string as the `surfaces[].id` in the ledger, so the ledger, this inventory and
`docs/EVIDENCE.md` stay in sync.

---

## D-1. `surface.fantasy402-sport-catalog`

Fantasy402 desk navigation catalog: sub-sport lanes plus per-sport period menus. Not in the spec at all.

| Fact                    | Value                                                                                                                           | Source                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Sports                  | 19                                                                                                                              | `fixture:tests/fixtures/fantasy402-sport-catalog-2026-10-21.json:2-8` |
| Sub-sports              | 230                                                                                                                             | same fixture                                                          |
| Period menus            | 42                                                                                                                              | same fixture (`sportPeriodCount`)                                     |
| Desk-link collision ids | 2 — `Arena` → Football + Horse Racing; `NCAA Extra` → Basketball + Hockey                                                       | same fixture `collisions`; `fantasy402_sport_catalog.ts:229-245`      |
| Provenance digests      | 4 — `subSportTreeSha256Hex`, `periodMenusSha256Hex`, `collisionRegistrySha256Hex`, `expectedEmptyPathsSha256Hex`                | `fantasy402_sport_catalog.ts:133-158,648-663`                         |
| `capturedAt`            | `2026-10-21T16:38:53.513Z`                                                                                                      | fixture                                                               |
| `periodsCapturedAt`     | `2026-10-30T04:59:14.572Z`                                                                                                      | fixture                                                               |
| Structural empties      | stable: Football/Coll Ext, Hockey/NCAA Extra, Horse Racing/Arena, Soccer/France Ligue; volatile: LIVE/MMA Live, LIVE/WNCAA Live | `fantasy402_sport_catalog.ts:57-66`                                   |

Why it matters: these are the `link_id` keys scoped ingestion uses. Two codes (`Arena`, `NCAA Extra`) are
shared across sports, which is why `makeDeskLinkId` rewrites them to `<Sport>|<code>` — a collision that
silently breaks ingestion if it is not represented.

**Caveat:** the fixture is the committed SSOT sample, not a raw wire capture. `capturedAt` is
fixture-declared. Validation is real (`validateFantasy402SportCatalog`, `fantasy402_sport_catalog.ts:448-530`):
declared counts must match computed counts, codes must be unique per sport, periods must number `0..n-1`
with period `0` named `Game`, and the two timestamps must not invert.

**Resolution:** add a catalog section/schema to the docs, citing the fixture (not a capture) and the digest
set.

---

## D-2. `surface.manager-getHistory`

The only upstream Fantasy402 route in this repo with an actual fetch client, and it is missing from the spec.

- Endpoint: `POST {SPORTSDESK_PORTAL_HTTP_BASE}/cloud/api/Manager/getHistory`
  (`lib/fantasy402_settlement_ingest.ts:347-357`).
- Poll semantics: `fetch(url, { method: "POST", proxy: false, signal: AbortSignal.timeout(60_000) })`, **no
  request body**; response must be an array or `{ data: [] }` or the poll throws
  (`lib/fantasy402_settlement_ingest.ts:359-387`).
- Role: settlement-history slice (`lib/fantasy402_wager_universe_scope.ts:22-31`, `ingestionStatus: "wired"`).
- Shape fixture: `tests/fixtures/fantasy402-history-poll.json` — `Login`, `WagerNumber`, `WagerStatus`
  (`S`/`C`), `AcceptedDateTime`, `GameDateTime`, `SettlementDateTime`, `Amount`, `Risk`, `ToWin`.

**Caveat:** the fixture rows are placeholders (`CUST001`, `CUST002`), so it is a shape sample, not a
capture. The request contract (agent scope, date window, auth) is unknown because the poll sends no body —
the spec cannot document this route accurately until a capture exists.

---

## D-3. `surface.manager-getGrading`

Declared "wired" but not implemented at the transport layer.

- Declared: `Manager/getGrading`, slice `settlement_history`, `ingestionStatus: "wired"`
  (`lib/fantasy402_wager_universe_scope.ts:32-38`); `SettlementFeed = "getHistory" | "getGrading"`
  (`lib/fantasy402_settlement_ingest.ts:17`).
- Row type: `RawGradingLegRow` — `CustomerID`, `WagerNumber`, `LegNumber`, `Amount` (cents, customer
  perspective: win > 0, loss < 0, void = 0), `SettlementDateTime`, `Result` (`WIN|LOSS|VOID|PUSH`),
  `Description` (`simulate_bettor_churn_suite.ts:81-89`).
- **No fetch exists:** repo-wide the only settlement poll is `pollManagerGetHistory`, which targets
  `getHistory`. `getGrading` is a declared feed with no client.

**Resolution:** either implement the poll and capture it, or stop calling it wired. It is absent from the
spec and should stay out until the transport is real.

---

## D-4. `surface.daemon-dashboard`

- `GET /` and `GET /dashboard` both serve `customer-churn-simulation-dashboard.html` as `text/html`
  (`sportsdesk_webview_server.ts:134-141`).
- No spec row; the spec documents only `/health`, `/api/watchlist` and the Telegram routes for the daemon.
- These are the operator-facing dashboards; the Scalar docs portal is a separate artifact (`docs/index.html`
  loading `docs/openapi.json`).

## D-5. `surface.daemon-miniapp`

- `GET /miniapp` and `GET /miniapp/` serve `telegram-miniapp-dashboard.html`
  (`sportsdesk_webview_server.ts:144-151`).
- Served with Telegram-specific CSP `frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:`
  and no `X-Frame-Options` (`sportsdesk_webview_server.ts:87-90`).
- Absent from the spec.

## D-6. `surface.daemon-telegram-admin-routes`

Real routes, no spec rows:

| Route                               | Behaviour                                             | Source                                 |
| ----------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| `POST /telegram/webhook`            | Validates `x-telegram-bot-api-secret-token`, else 401 | `sportsdesk_webview_server.ts:154-173` |
| `GET /api/telegram/status`          | Status + schedules + `REPORT_TYPES`                   | `sportsdesk_webview_server.ts:188-198` |
| `GET /api/telegram/activity?limit=` | Activity log, limit clamped 1–200                     | `sportsdesk_webview_server.ts:200-209` |
| `POST /api/telegram/webhook`        | `{action:"set"\|"delete"}` webhook management         | `sportsdesk_webview_server.ts:211-233` |
| `OPTIONS *`                         | 204 preflight with CORS headers                       | `sportsdesk_webview_server.ts:108-111` |
| `GET /api/test/error`               | Synthetic throw for the error boundary                | `sportsdesk_webview_server.ts:100-106` |

All `/api/telegram/*` and `/api/watchlist` calls pass through `adminRejection`
(`sportsdesk_webview_server.ts:27-47,175-186`): constant-time comparison against `SPORTSDESK_ADMIN_TOKEN`,
503 when the token is unset, 401 otherwise.

---

## D-7. `surface.gs-manager-cli`

The GS Buckeye 2 Partner 118 deliverable, extracted at
`/Users/nolarose/code/sportsdesk-ops/scratch/docs-audit/gs-manager-cli/`. It has **6 report kinds** and a
real CLI, but every upstream report contract is `blocked_contract`.

**6 report kinds** (`zip:templates/endpoint-registry.json:8,39,95,151,210,272`;
`zip:contracts/report-surfaces.md:9-16`):

| Report id   | Visible name    | UI route (browser, **not** an HTTP endpoint) | Contract                                                     |
| ----------- | --------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `summary`   | Summary report  | `/manager-tools/#/reports/summary`           | HTTP transport unknown                                       |
| `event`     | Event report    | `/manager-tools/#/reports/events`            | transport unknown                                            |
| `player`    | Player report   | `/manager-tools/#/reports/users`             | transport unknown                                            |
| `open-bet`  | Open bet report | `/manager-tools/#/reports/open-bets`         | transport unknown                                            |
| `bettor`    | Bettor report   | `/manager-tools/#/reports/bettor`            | transport unknown                                            |
| `last-bets` | Last Bets       | `/manager-tools/#/events/bet-history`        | action `getBetReport` observed; transport + response unknown |

**9 `jobs` subcommands** — `add`, `list`, `run`, `logs`, `enable`, `disable`, `remove`, `tick`, `unlock`
(`zip:src/cli.js:13-17`; `zip:templates/endpoint-registry.json:301-320` lists the command surfaces and
marks `notUpstreamEndpoints: true`).

**Other CLI surfaces:** `capabilities`, `report <kind>`, `serve`, `docs`, `cron print`
(`zip:src/cli.js:7-19`).

**Blocked-contract evidence:**

- `zip:README.md:3` — live acquisition intentionally blocked; no GS endpoint/authentication/response contract is verified.
- `zip:templates/contract-verification.md:3` — only Last Bets has an observed action; no transport URL, method, response shape or auth mechanism exists for any report.
- `zip:templates/endpoint-registry.json:281-288` — `url`, `method`, `contentType`, `responseSchema`, `authentication` all `null` for last-bets.
- `zip:contracts/gs-manager.ts:29-30` — no response capture exists; invented response properties prohibited.
- `zip:contracts/api-security-spec.md:29` — keep live acquisition blocked until contract and authorization controls are verified.

The CLI itself is real and tested (6 Node tests: DST bounds, invalid inputs, schedule dedup, blocked live
behaviour, lock exclusion, cron quoting) — the orchestration is implemented, the GS API is not.

---

## E-1. `surface.desk-api-unimplemented`

**9 spec paths / 10 operations** under `/api/desk/*` have no implementation anywhere in the repository:

| #   | Operation                        | Claimed behaviour                                                                    | Implementation |
| --- | -------------------------------- | ------------------------------------------------------------------------------------ | -------------- |
| 1   | `POST /api/desk/auth/session`    | Mint `desk_session_id` cookie (UUIDv7, 8h shift, SameSite=Strict)                    | none           |
| 2   | `DELETE /api/desk/auth/session`  | Revoke session                                                                       | none           |
| 3   | `GET /api/desk/auth/me`          | Inspect operator session                                                             | none           |
| 4   | `POST /api/desk/hitl/approve`    | HMAC-SHA256 `DESK-*` token, constant-time compare, dispatch `Manager/updateByColumn` | none           |
| 5   | `GET /api/desk/hitl/queue`       | List pending tier-2 limit adjustments                                                | none           |
| 6   | `POST /api/desk/hitl/reject`     | Reject queued limit raise                                                            | none           |
| 7   | `POST /api/desk/forensics/audit` | Run modes A/B/C/I, compute MFCS 0–100                                                | none           |
| 8   | `GET /api/desk/forensics/scores` | Empirical Bayes sharp scores (`tau*=0.68`, `N_min=8`)                                | none           |
| 9   | `POST /api/desk/rfq/quote`       | Polymarket/Kalshi RFQ joint-probability quote                                        | none           |
| 10  | `POST /api/desk/rfq/hedge`       | Execute layoff hedge                                                                 | none           |

Why "9 paths / 10 operations": `/api/desk/auth/session` carries both `POST` and `DELETE`.

Evidence of absence:

- `sportsdesk_webview_server.ts:96-307` is the complete daemon router: `/health`, `/`, `/dashboard`,
  `/miniapp`, `/telegram/webhook`, `/api/telegram/*`, `/api/watchlist`, `/api/telegram/alert|report`, then a
  404 JSON fallback at `:299-307`. No `/api/desk` prefix is matched.
- A repo-wide grep for `/api/desk` in code finds only documentation tests
  (`main:tests/api_reference.test.ts:55-56,91-100`) and the generator that wrote the spec
  (`scripts/enhance_docs.mjs:115,237,249,269,289,301,321`).
- There is no HMAC verifier, no `DESK-*` token codec, no `CookieMap` session store and no HITL queue store
  in either tree.

**Resolution:** implement and capture, or remove from the published contract / mark unimplemented. Do not
present these as callable routes in the docs release.

---

## Summary

| Tier                               | Count                               | Ids                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D — real surface missing from spec | 7                                   | `surface.fantasy402-sport-catalog`, `surface.manager-getHistory`, `surface.manager-getGrading`, `surface.daemon-dashboard`, `surface.daemon-miniapp`, `surface.daemon-telegram-admin-routes`, `surface.gs-manager-cli` |
| E — documented, not implemented    | 1 surface (9 paths / 10 operations) | `surface.desk-api-unimplemented`                                                                                                                                                                                       |

The D rows should be added to the docs (or explicitly scoped out with a one-line rationale). The E surface
should be removed from the published contract until code exists, or clearly badged as unimplemented.
