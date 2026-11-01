# Capture requests — SportsDesk / Fantasy402 docs release

Companion to [ledger.json](./ledger.json). Every item below states exactly what to capture, what is
currently claimed, and which ledger rows it would upgrade. Nothing here authorizes a live mutation:
capture read paths first, and treat every write capture as an operator-approved change on a controlled
account.

**Status of the release:** no operation has a captured response body. The only real wire artifact is the
2026-10-28 Manager HAR (portal `v1.0.279`), which recorded request headers and bodies for the Manager
calls but no response bodies. See `operational_guardrails_runbook.md:127-153`.

**Redaction rules (apply to every capture):** keep request/response _shape_; replace credentials, tokens,
cookies, IPs and customer IDs with stable placeholders. Never store `Authorization`, `Cookie`,
`Set-Cookie`, CSRF values, passwords or raw JWTs. Record header _names_ and auth _scheme_, not values.
Preserve scalar types when redaction changes a value (write `"customerID": "<PLACEHOLDER>"`, not `0`).

**Capture record format** (use for every artifact added to the repo):

```json
{
  "capturedAt": "YYYY-MM-DDTHH:MM:SSZ",
  "operator": "<role>",
  "portalVersion": "vX.Y.Z",
  "endpoint": "<exact URL as seen on the wire>",
  "method": "POST",
  "contentType": "<exact request Content-Type>",
  "requestHeaders": [
    "X-Requested-With: XMLHttpRequest",
    "Authorization: Bearer <REDACTED>"
  ],
  "requestBody": "<redacted, exact field order if it matters>",
  "status": 200,
  "responseContentType": "<exact>",
  "responseBody": "<redacted body or 'not captured'>",
  "redaction": "<what was replaced and how>"
}
```

---

## P1 — `getWebLog` modes A, C, I and any response body (highest value)

Ledger row: `POST /cloud/api/Manager/getWebLog` (tier B, **contradicted**). Mode B is the only mode ever
observed, and no response was captured, so:

- modes A / C / I are inferred from the form (`operational_guardrails_runbook.md:131`);
- the response row schema is unpublished (`operational_guardrails_runbook.md:153`);
- the spec requires an `Authorization` header the capture never had (`docs/openapi.json:386`).

**Observed mode-B request (baseline that is verified — do not re-derive it):**

```http
POST https://www.fantasy402.com/cloud/api/Manager/getWebLog
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Cookie: <REDACTED session cookie>

agentID=<sessionAgent>&customerID=0&start=10%2F28%2F2026&end=10%2F28%2F2026&type=B
&actions=ALL&ip=&operation=getWebLog&RRO=1&agentOwner=<sessionAgent>
```

**What to capture:**

| Mode               | Request changes vs the mode-B baseline                                              | Capture                                       |
| ------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| A — Web Access Log | `type=A`, same `MM/DD/YYYY` dates, `customerID=0`                                   | full 200 body                                 |
| C — Acct IP Match  | `type=C`, **both dates `YYYY-MM-DD`** (`runbook:129`), `customerID=<target bettor>` | full 200 body, both a hit and a zero-hit case |
| I — Users by IP    | `type=I`, `ip=<IPv4 or /24>`, `customerID` behavior unknown                         | full 200 body                                 |
| any                | exact request headers and cookies used                                              | status + response headers + body              |

Also record: `Content-Type` of the response, whether the body is an array or an envelope, whether the
four published fields (`customerID`, `ipAddress`, `timestamp`, `agentOwner`) actually appear, whether a
`path` field appears (it is deliberately omitted per `simulate_bettor_churn_suite.ts:122`), and whether
`Authorization` is accepted at all.

**Upgrades:** modes A/C/I from C→A; the response schema and auth claim move from _contradicted_ to
verified (or the spec is corrected). This is the single highest-value capture because it is the only
forensic endpoint the runbooks, the code and the spec all point at.

---

## P2 — `updateByColumn` mutation + `getInfoPlayer` read-back

Ledger rows: `POST /cloud/api/Manager/updateByColumn` (C), `POST /cloud/api/Manager/getInfoPlayer` (B,
example-level contradiction). `operational_guardrails_runbook.md:215` states the only HAR does **not**
include `updateByColumn`, that the only observed padded ID is `Log/write`'s at **10** characters, and that
the **11**-character width must be confirmed by capture before anyone relies on it. The spec
(`docs/openapi.json:609-754`) publishes a 9-field body and `Result` 1/0/-1 semantics on no evidence.

**Capture on a controlled test account only.**

```http
POST https://www.fantasy402.com/cloud/api/Manager/updateByColumn
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Cookie: <REDACTED session cookie>

operation=updateByColumn&customerID=<11-char padded>&agentID=<direct sub-agent>&agentOwner=<direct sub-agent>
&columnName=confirmationDelaySeconds&type=0&value=6&title=confirmationDelaySeconds&information=&special=&RRO=1
```

Then immediately:

```http
POST https://www.fantasy402.com/cloud/api/Manager/getInfoPlayer
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

customerID=<same ID, try trimmed first>&agentID=<direct sub-agent>
```

Record: (a) whether the padded **11**-char ID is accepted, the **10**-char form, or the trimmed 7-char
form; (b) the exact `Result` envelope; (c) a wrong-scope attempt (master `BILLY666`) if safe on a test
account, to confirm `-1`; (d) the before/after `getInfoPlayer` body — `runbook:213` observed reads sending a
**trimmed** 7-char ID while the spec example sends the padded form; (e) whether a `path` field really
produces the empty-body 500 the spec claims.

**Upgrades:** `updateByColumn` C→A and confirms/refutes `PaddedCustomerId` width, `SILENT_NO_OP`,
`REJECTED_SCOPE`, `POISONED_PATH_500`; `getInfoPlayer` B→A and resolves its padded-vs-trimmed example
contradiction.

---

## P3 — `authenticateCustomer` (the whole auth model rests on it)

Ledger row: `POST /cloud/api/System/authenticateCustomer` (C). The spec claims a scoped Bearer JWT with a
~20–25 minute lifetime; the one observed Manager session is cookie-based and sends no `Authorization`
header (`runbook:153`). Neither claim is evidenced.

```http
POST https://www.fantasy402.com/cloud/api/System/authenticateCustomer
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

customerID=<agent or bettor ID>&password=<REDACTED>
```

Capture: HTTP status, `Set-Cookie` names/attributes (redacted values), response body keys (`code`?
`accountInfo`?), token prefix/length and expiry, and **the headers of the very next Manager call** — that
last part is what decides cookie vs Bearer. Also capture the failure case (bad password) and any
Cloudflare/HTML challenge page.

**Upgrades:** C→A; determines whether `BearerAuth`/`AuthBearer` in `docs/openapi.json` (and the 24
operations that reference `BearerAuth` without a `securitySchemes` entry) is correct or must be replaced
with a cookie scheme.

---

## P4 — GS `getBetReport`: transport, content type, response (the biggest upstream gap)

Ledger row: `POST /manager-tools/ajax.php` (tier B, **contradicted**). The GS extract forbids exactly what
the spec publishes:

- `zip:README.md:3` — "Live acquisition is intentionally blocked: no GS endpoint/authentication/response contract is verified."
- `zip:contracts/contract-map.md:14` — "No endpoint URL, method, auth scheme, Summary action, pagination, or upstream response schema is fabricated here."
- `zip:contracts/gs-manager.ts:29-30` — "No response capture exists: assigning invented response properties is prohibited."
- `zip:templates/endpoint-registry.json:281-288` — last-bets upstream `url`, `method`, `contentType`, `responseSchema`, `authentication` are all `null`.
- `zip:templates/contract-verification.md:3` — "no transport URL, method, response shape, or auth mechanism has been established for any report."

The only observed artifact is a user-supplied request payload (`zip:contracts/get-bet-report.observed.json`):

```json
{
  "action": "getBetReport",
  "partnerUserId": "",
  "agent": "",
  "eventId": "",
  "freeBetId": "",
  "state": "",
  "sId": "2",
  "minVolume": "0",
  "maxTimeUntilScore": "0",
  "mId": "",
  "from": 1793250000,
  "fromTime": 0,
  "to": 1793422799,
  "toTime": 86399,
  "betId": "",
  "betGroupId": "",
  "group": null,
  "dateFilterBy": "calcTime",
  "partnerIds": "",
  "period": "s3"
}
```

**What to capture.** In the GS manager-tools UI (`https://plive.sportswidgets.pro/manager-tools/#/events/bet-history`),
open browser devtools Network, submit the Last Bets report for a short authorized window, and export the
one reporting request + response as HAR (redacted). Do **not** guess `/manager-tools/ajax.php`; record the
URL that actually fires. Record:

1. actual transport URL and path prefix;
2. HTTP method;
3. exact request `Content-Type` (JSON vs `application/x-www-form-urlencoded`);
4. full redacted request body — observe `action` vs `operation`, whether `partnerIds` carries tenant 118,
   `sId`/`period`/`state` semantics, `from`/`to`/`fromTime`/`toTime` interaction, `group` null vs omitted;
5. full redacted response — envelope, rows path, field names/types, pagination/totals, empty case;
6. auth/CSRF mechanism and tenant enforcement without storing values.

**Upgrades:** resolves the `manager-tools` contradiction and moves that row B→A; closes the biggest
unknown in the release. Until this exists, no markdown may present `getBetReport` as an HTTP contract.

---

## P5 — the unbacked cloud operations

**12 operations are fully unbacked:** no capture, no observed request, and no repo TypeScript wire type —
their spec bodies exist only because the spec or `scripts/enhance_docs.mjs` authored them. Capture each
once read-only where possible; the mutations need a controlled test account.

Expected auth: the Manager portal session cookie observed in the 2026-10-28 HAR (no `Authorization` header;
`operational_guardrails_runbook.md:153`) — record the actual `Cookie` header names plus the
`X-Requested-With` / `Referer` values (redacted), and note if any call accepts Bearer instead.

| #   | Operation               | Candidate URL / content type                                                                           | What to capture                                                                                                                                                                                                                                                         | Upgrades                              |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | `getBetTickerConfig`    | `POST /cloud/api/Manager/getBetTickerConfig`, form-urlencoded                                          | one request; the `INFO:false` misconfigured shape                                                                                                                                                                                                                       | C→A                                   |
| 2   | `vigSetupInsert`        | `POST /cloud/api/Manager/vigSetupInsert`, spec says `application/json` with 20-char padded `sportType` | one insert + `getSportsVigSetup` read-back on a test account                                                                                                                                                                                                            | C→A; validates the JSON-vs-form claim |
| 3   | `getSportsVigSetup`     | `POST /cloud/api/Manager/getSportsVigSetup`, form-urlencoded                                           | paired read-back with #2                                                                                                                                                                                                                                                | C→A                                   |
| 4   | `getInfoManager`        | `POST /cloud/api/Manager/getInfoManager`, form-urlencoded                                              | dashboard header call; exact JSON keys (spec's hyphenated `grand-total-weekly` is unusual)                                                                                                                                                                              | C→A                                   |
| 5   | `getWeeklyFigure`       | `POST /cloud/api/Report/getWeeklyFigure`                                                               | one Reporting weekly-figure capture. `data-action="get-weekly-figure"` **is** real (portal left-menu markup, `tests/fixtures/portal-left-menu-actions.html`); whether that action calls this path rather than `Manager/getWeeklyFigureByAgentLite` is the open question | C→A                                   |
| 6   | `verifySession`         | `POST /cloud/api/System/verifySession`                                                                 | live token + expired token; response shape and the 401 re-mint behavior                                                                                                                                                                                                 | C→A                                   |
| 7   | `getCustomerNotes`      | `POST /cloud/api/Manager/getCustomerNotes`, form-urlencoded                                            | one read; note row fields, author/timestamp semantics                                                                                                                                                                                                                   | C→A                                   |
| 8   | `updateCustomerNotes`   | `POST /cloud/api/Manager/updateCustomerNotes`, form-urlencoded                                         | one append + read-back on a test customer; Result envelope; immutability                                                                                                                                                                                                | C→A                                   |
| 9   | `deleteSportsVigSetup`  | `POST /cloud/api/Manager/deleteSportsVigSetup`, form-urlencoded                                        | delete + `getSportsVigSetup` read-back on a test account                                                                                                                                                                                                                | C→A                                   |
| 10  | `deleteWager`           | `POST /cloud/api/Manager/deleteWager`, form-urlencoded                                                 | void/cancel + audit-log read-back on a test ticket; exact required fields (only `wagerNumber`/`reason` are documented)                                                                                                                                                  | C→A                                   |
| 11  | `getDeletedWagerReport` | `POST /cloud/api/Report/getDeletedWagerReport`                                                         | one Reporting capture; resolve whether it is distinct from `delete-wager`                                                                                                                                                                                               | C→A                                   |
| 12  | `getDailyFigure`        | `POST /cloud/api/Report/getDailyFigure`                                                                | one capture; confirm whether it takes a request body at all                                                                                                                                                                                                             | C→A                                   |

**Two more feeds have repo wire types but no capture** — lower priority, still unverified:

| #   | Operation      | Candidate URL / content type                                                                                                                     | What to capture                                                                                                            | Upgrades                                  |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 13  | `getBetTicker` | `POST /cloud/api/Manager/getBetTicker`, form-urlencoded                                                                                          | an initial call (`wagerNumber=0`) and a delta call; exact body; `INFO`/`LIST` envelope; row keys/types; watermark behavior | C→A; validates the delta-watermark design |
| 14  | `getPending`   | `POST /cloud/api/Manager/getPending` — **content type contested**: the spec says `application/json`, every other Manager call is form-urlencoded | exact content type + one non-empty response; confirm `BLOCKED`/zero-stake sentinel rows actually appear                    | C→A                                       |

`authenticateCustomer` is deliberately not in this table — the whole auth model needs its own capture and
is §P3. Two rows with partial observation are tracked elsewhere: `updateByColumn` (§P2) and
`search`/`getAgentPerformance`/`getSettledFigure`/`delete-wager`/`getAnalysis`/`getFinancialReport`
(§P6 — UI action names observed, URLs not). `getAgentPerformance` now has one step more: two request
bodies were observed on 2026-11-01 — the all-periods call (`subsport`/`wagerType`/`betType` empty,
`period=-1`) and the same call with the sport filter row filled (`subsport=NFL`, `period=1`,
`wagerType=M`, `betType=S`) — recorded in
`tests/fixtures/f402-report-requests-observed-2026-11-01.json`, together with a byte-exact encoding pin.
The URL those bodies were POSTed to was not observed, and no response exists.
`lib/f402_agent_performance_request.ts` now reproduces either body from a typed selection (byte-exact
against both observations, catalog-validated), so the capture operator can generate the request instead
of hand-building a curl.

**Observed request, still unledgered: `getSubSportByReport`.** A 2026-11-01 operator paste shows
`POST /cloud/api/Manager/getSubSportByReport`, form-urlencoded, with
`customerID`, `sport` (padded to 20 characters — `Football` plus 12 spaces), `operation`, `RRO=1`,
`agentID`, `agentOwner`. A browser stack trace from the same session names the caller:
`getSubsport()` in `app/manager/module/agent-performance.js?bust=1.0.280`, through jQuery `$.ajax` —
which is also why the request is form-encoded with `X-Requested-With`. That module is the screen whose
report is `getAgentPerformance`, so the two observed requests belong to one page. It is the call that
fills the report's sub-sport picker, the wire counterpart of `lib/sport_catalog.ts`. It has
**no ledger row and no spec path on purpose**: a tier-B row would need a response schema, and nobody
has seen the response. Capture it (URL, body, rows) and it becomes a real operation with a real schema
rather than an authored one.

## P6 — the 11 "Tracked Operational Domains" candidates

Ledger rows: the 11 `POST /cloud/api/...` operations tagged `Tracked Operational Domains` (all tier C,
`candidate_url: true`, `ui_observed: true`). Their path+method come from hand-authored constants in
`scripts/portal_tile_crawler.ts:40-162`; the crawler's CLI
entry runs the `offline` branch (`portal_tile_crawler.ts:670,680`) and never records network traffic.
The former post-processor draft (`append_tracked_domains.mjs`) was removed: it mutated the generated
spec and reference outside the ledger, duplicated this table, and failed the docs gate.
The markdown table calls them "Target Wire Endpoint" (`docs/api-reference.md:693`), which is an overclaim.

For each tile: open the Manager dashboard, click the tile, and capture the network request it actually
fires (URL incl. `/Manager` vs `/Report` vs another model prefix, method, content type, body, auth) plus a
response. Then correct the path/method in the spec if they differ. Expected auth is the same Manager session
cookie; the `/cloud/api/<Model>/<method>` shape means the _model prefix_ is the least certain part of each
candidate and must be read off the wire, not inferred from the tile name.

| Tile                 | Candidate path + method                     | DOM selector (declared)                     | Declared inputs                                          | Upgrade if captured                                    |
| -------------------- | ------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Game Admin           | `POST /cloud/api/Manager/gameAdmin`         | `div.tile:has-text('Game Admin')`           | rotationNumber, sportType, circleLimit, isLocked         | C→A                                                    |
| Messaging            | `POST /cloud/api/System/getMessages`        | `div.tile:has-text('Messaging')`            | recipientScope, subject, messageBody, priority           | C→A                                                    |
| Cashier              | `POST /cloud/api/Manager/adjustBalance`     | `div.tile:has-text('Cashier')`              | customerID, amountCents, transactionType, notes          | C→A (write: test account only)                         |
| Add Customer         | `POST /cloud/api/Manager/createPlayer`      | `div.tile:has-text('Add Customer')`         | customerID, agentID, password, creditLimit, delaySeconds | C→A (write: test account only)                         |
| 3rd Party Limits     | `POST /cloud/api/Manager/get3rdPartyLimits` | `div.tile:has-text('3rd Party Limits')`     | providerID, sportCategory, maxLimitCents                 | C→A                                                    |
| Analysis             | `POST /cloud/api/Report/getAnalysis`        | `div.tile:has-text('Analysis')`             | period, sport, marketCategory, agentID                   | C→A — also has UI action-name evidence (`runbook:166`) |
| Scores               | `POST /cloud/api/Manager/getScores`         | `div.tile:has-text('Scores')`               | gameID, periodIndex, homeScore, awayScore, isFinal       | C→A                                                    |
| Agent Admin          | `POST /cloud/api/Manager/getAgentTree`      | `div.tile:has-text('Agent Admin')`          | masterAgent, commissionSplitPercent, creditCeiling       | C→A                                                    |
| Billing              | `POST /cloud/api/Manager/getBilling`        | `div.tile:has-text('Billing')`              | billingWeek, ratePerActiveHead, activeAccountCount       | C→A                                                    |
| Settings & Rules     | `POST /cloud/api/Manager/getRules`          | `div.tile:has-text('Rules')`                | parlayMaxPayout, teaserTieRule, defaultDelaySeconds      | C→A                                                    |
| Transactions History | `POST /cloud/api/Report/getFinancialReport` | `div.tile:has-text('Transactions History')` | customerID, startDate, endDate, transactionFilter        | C→A — also has UI action-name evidence (`runbook:167`) |

The declared inputs are **form-field names seen in the DOM**, not request-body fields. Capture must
establish whether they are POSTed under those names, under a wrapper, or not at all.

---

## P7 — captures that are not needed (reconcile spec to code instead)

These local daemon routes are served by `sportsdesk_webview_server.ts`; the handler is the contract. The
spec is missing parameters/response fields and should be corrected from source:

| Operation                   | Handler                                           | Spec drift to fix                                                         |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /health`               | `sportsdesk_webview_server.ts:114-131`            | add `url`, `timestamp` to the response                                    |
| `GET /api/watchlist`        | `sportsdesk_webview_server.ts:236-246` + `:27-47` | add 401/503 responses from `adminRejection`                               |
| `POST /api/telegram/alert`  | `sportsdesk_webview_server.ts:249-274`            | document the admin-token gate                                             |
| `POST /api/telegram/report` | `sportsdesk_webview_server.ts:277-297`            | add the `?type=` query parameter (enum `REPORT_TYPES`) and the `ok` field |

Also absent from the spec and documented from source only: `GET /`, `GET /dashboard`, `GET /miniapp`,
`POST /telegram/webhook`, `GET /api/telegram/status`, `GET /api/telegram/activity`,
`POST /api/telegram/webhook`, `OPTIONS` preflight and `GET /api/test/error` (see
[surfaces.md](./surfaces.md)).

The `/api/desk/*` routes cannot be captured: no implementation exists anywhere in the repo. They need
implementation first (`sportsdesk_webview_server.ts` has no `/api/desk` handler and 404s at `:299-307`).

## P7 — the customer report surface (7 candidates)

`lib/combo_identity.ts:24-40` names these from the deobfuscated `customer/report/report.js`. None has a
capture; they are published as tier C with no request or response content.

| Endpoint                                           | Used by                  | Required capture                                         |
| :------------------------------------------------- | :----------------------- | :------------------------------------------------------- |
| `POST /cloud/api/Report/Pending`                   | pending-bet modes        | one authenticated call + leg rows; confirm contentType   |
| `POST /cloud/api/Report/PendingDelete`             | ticket deletion          | one call on a test ticket; confirm the response envelope |
| `POST /cloud/api/Report/getDailyFiguresByCustomer` | 7-day P/L                | one call; confirm the figure row fields                  |
| `POST /cloud/api/Report/getGradedWagerByCustomer`  | Modes 8/10 (settled net) | one call + graded rows                                   |
| `POST /cloud/api/Report/getTransactions`           | Modes 8/10 (ledger)      | one call + ledger rows                                   |
| `POST /cloud/api/Report/getGrading`                | figure-date grading      | one call with a date filter + rows                       |
| `POST /cloud/api/Report/getTicketDetailPrint`      | ticket detail            | one call; confirm whether the response is HTML           |

`getGradedWagerByCustomer`, `getGrading`, `getTransactions` and `getDailyFiguresByCustomer` are the
settlement plane the operator runbook advertises; treat their current spec entries as candidates.

## Status after the 2026-10-31 live run

Captured live (tier A): `getWebLog`, `getInfoPlayer`, `getBetTicker`, `getBetTickerConfig`,
`getSportsVigSetup` — records in `captures/2026-10-31/`.

Still needed: `getPending` / `getInfoManager` / `getCustomerNotes` request templates (HTTP 500 with the
current envelope); a live **sub-sport/period** capture from the Ticketwriter/board surface; and the
remaining cloud operations (authenticateCustomer, updateByColumn, etc.). Live sports parity is checked
by `catalog:probe` (`getSportsType`, 19/19 identical to the fixture).
