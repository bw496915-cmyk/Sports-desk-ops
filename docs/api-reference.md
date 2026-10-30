# Fantasy402 & SportsDesk Operational Wire API Reference

Authoritative wire contract specification, JSON return shapes, headers matrix, L-key localization bindings, and authentication gotchas for the **Fantasy402 PPH Platform** and **SportsDesk Management Suite** (`desk.bookdeskops.com`) under **Bun v1.4+**.

## 1. Operational Domains Overview

| Domain / Tag | Endpoints | Core Operational Purpose | Fail-Closed Stance |
| :--- | :--- | :--- | :--- |
| **System & Authentication** | 4 | JWT session minting, validation, and operator session lifecycle | Re-mint 1x on 401, fail closed (`EX_DATAERR 72`) |
| **Manager & Player Admin** | 7 | `updateByColumn` atomic mutations, player info read-backs, omnisearch, notes | Enforce 11-char space padding, reject unpadded (`EX_USAGE 64`) |
| **Vig & Juice Setup** | 3 | Custom juice shading (+15c main spreads/totals, +20c derivatives) | Enforce 20-char sport padding, zero silent failure |
| **Wagers & Live Surveillance** | 4 | Real-time ticker streaming, pending ticket grouping, wager cancellation | Drop `BLOCKED` sentinels, watermark delta polling |
| **Reporting & Forensics** | 6 | Forensic IP tracker (Modes A, B, C, I), weekly rollups, branch ratings | Classify dwell velocity & /24 subnet clusters |
| **Desk & HITL Operations** | 5 | HMAC-SHA256 limit approvals, sharp detection scores, and MFCS engine | Constant-time token verification, strip `unsafe-url` (`EX_NOPERM 77`) |
| **Prediction Market RFQ** | 2 | Polymarket Combos & Kalshi RFQ multi-leg pricing and layoff hedging | 15s quote expiration, single-execution hedge guarantee |
| **Internal & Partner Feeds** | 5 | Health probes, watchlist streaming, Telegram alerts, and Partner 118 steam join | Fail-closed network deadlines |

## 2. Complete HTTP Headers Matrix

### 2.1 Outbound Request Headers

| Header Name | Required? | Wire Value / Syntax | Operational Purpose & Enforcement | Failure Mode if Omitted / Malformed |
| :--- | :--- | :--- | :--- | :--- |
| `Authorization` | **Yes** | `Bearer <JWT>` | Transmits authenticated JWT token (~20-25 min lifetime). | **HTTP 401**: Missing or bad auth format. |
| `X-Requested-With` | **Yes** | `XMLHttpRequest` | Proves AJAX origin to OpenResty routing filter. | **HTTP 401 / Redirect**: OpenResty rejects non-AJAX callers. |
| `Accept` | **Yes** | `application/json` | Mandates JSON wire payloads over HTML error wrappers. | Server emits HTML error page with `<` on faults. |
| `Content-Type` | **Yes** | `application/x-www-form-urlencoded` or `application/json` | Dictates payload serialization: form-encoded for `updateByColumn` and `getWebLog`; JSON for `vigSetupInsert`, `getPending`, and RFQ. | **HTTP 400 / 500**: Payload unparsed or poisoned. |
| `Referrer-Policy` | **Yes** | `no-referrer` | Strips `Referer` URL to prevent internal routes and HMAC tokens from leaking. | **HTTP 403**: HITL routes reject `unsafe-url`. |
| `Cookie` | Conditional | `desk_session_id=<uuidv7>` | Authenticates SportsDesk operator on `/api/desk/*` routes. | **HTTP 401**: Unauthenticated operator session. |

### 2.2 Inbound Response Security Headers

| Response Header | Wire Value | Security & Runtime Purpose |
| :--- | :--- | :--- |
| `Content-Type` | `application/json; charset=utf-8` | Strictly typed JSON payload encoding. |
| `Set-Cookie` | `desk_session_id=...; HttpOnly; Secure; SameSite=Strict; Path=/api/desk; Max-Age=28800` | Provisions 8-hour operator session cookie via native Bun `CookieMap`. |
| `X-Content-Type-Options`| `nosniff` | Blocks MIME type sniffing across proxies and webviews. |
| `Cache-Control` | `no-store, no-cache, must-revalidate` | Prevents browser and proxy caching of real-time wagering risk data. |
| `Content-Security-Policy` | `frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;` | Replaces obsolete `X-Frame-Options: ALLOWALL` for secure Telegram Mini App mounting. |

## 3. API Session & Wire Gotchas (The Complete Checklist)

Every operator, script, and background daemon must adhere to the **15 Canonical Wire Gotchas** discovered across live production HAR analysis and engine runbooks:

1. **Authorization Channel Isolation**: Passing `X-JWT-Assertion: <jwt>` or custom headers returns HTTP 401 HTML; authentication strictly requires `Authorization: Bearer <JWT>`.
2. **Request Body JWT Prohibition**: Placing `code: <jwt>` in request bodies returns HTTP 401; tokens belong exclusively in headers.
3. **Dead Session HTML Detection**: Expired sessions and Cloudflare challenges return HTML starting with `<` (`<!DOCTYPE` or `<html`); parsers must inspect `text.trim().startsWith('<')` and trigger an automated re-mint cycle instead of failing on JSON syntax errors.
4. **20–25 Minute Session Decay**: JWT tokens expire after ~20–25 minutes; clients transparently re-authenticate credentials 1x via `authenticateCustomer` and retry in-flight calls before aborting with `EX_DATAERR` (72).
5. **CSRF Pairing Atomic Requirement**: Submitting `sessionId` without `clientCsrfToken` (or vice versa) triggers `CSRF_PAIRING_MISMATCH` (HTTP 403, `EX_NOPERM` 77).
6. **Referrer Leakage Gate**: Inbound HITL approval routes reject `req.referrerPolicy === 'unsafe-url'` with HTTP 403 to protect `DESK-*` tokens.
7. **CookieMap Session Binding**: Operator sessions use native Bun `CookieMap` with time-ordered `Bun.randomUUIDv7()` and `SameSite=Strict`.
8. **Zero Embedded URL Credentials**: URLs formatted as `https://user:pass@host` are blocked across the runtime to prevent credentials leaking into error stack traces.
9. **Space-Padding Contract (`PaddedCustomerId`)**: Writing unpadded logins (`"CB112"`) to `updateByColumn` or `vigSetupInsert` yields `Result.Result = 0` (`SILENT_NO_OP`); logins must be padded to strictly 11 characters (`"CB112_1    "`).
10. **Scope Hierarchy Rule**: Supplying master agent `"BILLY666"` on mutations yields `Result.Result = -1` (`REJECTED_SCOPE`); writes must name the direct owning sub-agent (`"CUB22HR"`).
11. **Poisoned Path Trigger**: Passing a `path` parameter in form bodies poisons `updateByColumn`, causing an empty HTTP 500 response (`POISONED_PATH_500`).
12. **Qubic UI Rewrite Illusion**: Direct HTTP calls to `/qubic/api/...` yield HTTP 404 (`QUBIC_UI_ONLY_404`); requests must target `/cloud/api/...`.
13. **Model Routing Trap**: Calling `/cloud/api/Customer/updateByColumn` returns HTTP 400 `Invalid Method: Model:` (`MODEL_ERROR`); customer mutations must route through `/Manager/updateByColumn`.
14. **Vig Setup Wire Format**: `vigSetupInsert` requires `application/json` with 20-character space-padded `sportType` (`"Football            "`), whereas `getSportsVigSetup` requires `application/x-www-form-urlencoded`.
15. **Pending Noise Sentinel Drops**: Raw `getPending` streams contain noise rows with `TicketWriter === "BLOCKED"` (`L19.N0518`) and zero-stake placeholders; these must be dropped before grouping legs into parent tickets.

## 4. Complete L-Key Dictionary: Layer Tokens & Manager DOM Mapping

### 4.1 Neuron Layer Tokens (Layers 18–28 SSOT Registry)

| Neuron Token | Semantic Label | WagerSource / Route | Hex Color | Color Swatch | DOM CSS Class | Latency / Gate Threshold | Operational Function |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`L18.N0204`** | Retail Pregame Baseline Gate | `Internet` | `#1d84b5` | Sky Blue | `.f402-row-retail` | 1,500 ms SLA | Monitors standard casual pregame bets; serves as the canonical counterpart in digital twin matching. |
| **`L19.N0518`** | Blocked Sentinel & Noise Filter | `BLOCKED` | `#64748b` | Slate Gray | `.tier-blocked-slate` | `{ kind: "sentinel_drop" }` | Drops zero-stake and voided rows before multi-leg grouping to prevent corrupting parent parlay leg arrays. |
| **`L20.N1105`** | Equilibrium Confirm & Vig Gate | `GATEWAY` | `#10b981` | Emerald Green | `.theme-sd-emerald` | 1,000 ms SLA | Monitors overall book hold equilibrium and verifies +15c/+20c vig persist read-backs via `getSportsVigSetup`. |
| **`L21.N0884`** | Syndicate Sub-Account Alert Twin | `ALERT` | `#ef4444` | Crimson Red | `.f402-row-alert` | 250 ms SLA | Shadow wagers mirroring sharp sub-accounts; enforces `canonicalVolumeCents = 0` to prevent double-counting. |
| **`L22.N1402`** | Steam / Line Chase Phrasing | `GSBUILDER` | `#f59e0b` | Amber-500 | `.tier-amber-steam` | 1,000 ms SLA | Correlated Same-Game Parlay (SGP) proposition builder joined via `M.G<betGroupId>`; steerable via `--steer`. |
| **`L23.N0412`** | Whale Sizing Anomaly | `GSLIVE` | `#28a745` | Forest Green | `.f402-row-whale` | 500 ms SLA | High-stake in-play live derivatives ($2,000+); forces `rotationGrade = "LIVE"`, extracts `M.G<id>`, routes to +20c vig tax. |
| **`L24.N2019`** | Recreational Longshot Bias | `CSLEVEL2` | `#38bdf8` | Light Sky | `.tier-rec-longshot` | 2,000 ms SLA | Customer service telephone bets and manual desk entries; monitors longshot parlay bias and clerk overrides. |
| **`L25.N1882`** | Adverse Selection & Steam Convergence | `--sd-route-devig` | `#06b6d4` | Cyan-500 | `.route-devig-cyan` | Consensus lag $\le 5\text{s}$ | Fast market line move convergence against Pinnacle reference; initiates devig spread recalculation. |
| **`L26.N3104`** | CLV Margin Decay & Shrinkage | `--sd-route-sharp` | `#a855f7` | Purple-500 | `.route-sharp-purple` | $\tau^* = 0.68, N_{\min} \ge 8$ | Online Empirical Bayes sharp detection ($k_{\text{flow}}=6.0, k_{\text{clv}}=10.0$); flags systematic Closing Line Value extractors. |
| **`L27.N0912`** | Liquidity Exhaustion Circuit Breaker | `--sd-route-pending` | `#d97706` | Dark Amber | `.route-halt-amber` | Top depth $< \$1,000$ | Triggers automated exposure circuit breakers when top-of-book market liquidity drops below safety thresholds. |
| **`L28.N2501`** | Terminal Execution Write-Gate | `--sd-route-manager` | `#f43f5e` | Rose-500 | `.route-gate-rose` | MFCS $\ge 80$ | Execution write-gate triggering dynamic 6s confirmation delay and limit clamp via `Manager/updateByColumn`. |

### 4.2 Manager DOM Localization Keys (`data-language="L-xxxx"`)

| DOM Localization Key | Header Label / UI Component | Wire Mapping Property | Purpose & Surveillance Binding |
| :--- | :--- | :--- | :--- |
| **`L-1029`** | **`Source`** | `TicketWriter` | Ingestion channel discriminator (`Internet`, `ALERT`, `GSLIVE`, `GSBUILDER`, `CSLEVEL2`). Primary hook for digital twin reconciler. |
| **`L-1028`** | **`Ticket #`** | `WagerNumber` | Monotonic parent wager identifier. Key component of parent composite key `${Login}\|${WagerNumber}`. |
| **`L-1031`** | **`Player / Account`** | `Login` / `customerID` | Customer account identifier. Trimmed for queries, right-padded to 11 characters (`PaddedCustomerId`) on mutations. |
| **`L-1032`** | **`Agent`** | `agentOwner` / `agentID` | Direct owning sub-agent hierarchy node (e.g. `CUB22HR`). Validates scope to prevent `REJECTED_SCOPE` (-1). |
| **`L-1033`** | **`Date / Time`** | `PlacedTimestamp` | Placed timestamp (ISO UTC). Evaluates session-to-wager dwell velocity ($\Delta t_{\text{velocity}} = t_{\text{placed}} - t_{\text{login}}$). |
| **`L-1034`** | **`Sport`** | `SportType` | Normalized sport category. Padded to strictly 20 characters (`"Football            "`) on `vigSetupInsert`. |
| **`L-1035`** | **`Description`** | `ShortDesc` | Selection description containing bet type (`ShortDesc[0]`), line, odds, and optional `M.G<betGroupId>` headers. |
| **`L-1036`** | **`Risk`** | `Risk` | Stake amount in dollars. Stored in SQLite strictly as integer `Cents` (`Math.round(risk * 100)`). |
| **`L-1037`** | **`To Win`** | `Win` / `ToWin` | Potential payout amount in dollars. Stored as integer `Cents`. |
| **`L-1038`** | **`Result / Status`** | `Result` / `Status` | Ticket resolution status (`Pending`, `Won`, `Lost`, `Pushed`, `Canceled`). |
| **`L-1039`** | **`IP Address`** | `ipAddress` | Originating client IP. Feeds Mode B global cross-agent matcher and Mode I /24 subnet clustering. |
| **`L-1040`** | **`Delay`** | `Delay` | Dynamic confirmation delay gate in seconds. Mutated via `updateByColumn` (default 0s, sharp clamp 6s). |
| **`L-1045`** | **`Balance`** | `CurrentBalance` | Player outstanding ledger balance. Verified during read-back via `getInfoPlayer`. |
| **`L-1050`** | **`Weekly Total`** | `grandTotalWeekly` | Mobile header KPI feeding management gross turnover. Verified via `getInfoManager`. |

## 5. TicketWriter Ingestion Channels & Wire Contracts

| `TicketWriter` Value | Layer & Token | Execution Source | Wire ShortDesc Codes | Latency SLA | Volume Rule (`canonicalVolumeCents`) | Primary Forensic Exposure |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`"Internet"`** | `L18.N0204` (`#1d84b5`) | Retail Web Portal | `S, P, T, C, E` | 1,500 ms | $\min(\text{Risk}, \text{Win})$ (`null` on Teasers) | Casual pregame flow; target counterpart in digital twin matching. |
| **`"ALERT"`** | `L21.N0884` (`#ef4444`) | Syndicate Mirror Feed | `S, P, L, G, M` | 250 ms | **Strictly `0`** | Bot sniper sub-account mirror slips; precedes web slips by $\le 6\text{s}$. |
| **`"GSLIVE"`** | `L23.N0412` (`#28a745`) | GS Partner 118 In-Play | `M` (ticker), `G` (pending) | 500 ms | $\min(\text{Risk}, \text{Win})$ | Whale sizing anomalies; exposes `M.G<id>` and omits `Team`/`Line`. |
| **`"GSBUILDER"`** | `L22.N1402` (`#f59e0b`) | Same-Game Prop Engine | `C, M, P` | 1,000 ms | $\min(\text{Risk}, \text{Win})$ | Multi-leg correlated prop stacks; carries `<br>` delimited legs. |
| **`"CSLEVEL2"`** | `L24.N2019` (`#38bdf8`) | Clerk / Manual Desk | `L, S, C, E` | 2,000 ms | $\min(\text{Risk}, \text{Win})$ | Telephone desk orders, manual line overrides, and doubles tennis. |
| **`"BLOCKED"`** | `L19.N0518` (`#64748b`) | Noise Filter Sentinel | Empty or any | Sentinel drop | **Dropped** (not evaluated) | Zero-stake placeholders and voided legs; must drop before grouping. |
| **`"GATEWAY"`** | `L20.N1105` (`#10b981`) | Equilibrium Sentinel | Empty | 1,000 ms | Diagnostic check | Margin balance and +15c/+20c vig verification read-backs. |

## 6. Error Taxonomy & Sysexits Matrix

| Error Classification | HTTP Status | Sysexit Code | Retryable? | Root Cause & Operational Resolution |
| :--- | :--- | :--- | :--- | :--- |
| **`COMMITTED`** | 200 | `EX_OK` (0) | No | Mutation confirmed upstream; read-back succeeded. |
| **`UNVERIFIED_COMMIT`** | 200 | `EX_OK` (0) | **No** | Upstream returned `Result=1`, but read-back timed out. Flagged `isCommitted = true` to strictly prevent duplicate write retries. |
| **`SILENT_NO_OP`** | 200 | `EX_USAGE` (64) | **No** | Unpadded login passed (`"CB112"` instead of `"CB112_1    "`). Fix client padding before resubmitting. |
| **`REJECTED_SCOPE`** | 200 | `EX_USAGE` (64) | **No** | Master agent passed (`"BILLY666"`) instead of direct parent sub-agent (`"CUB22HR"`). Re-bind to sub-agent. |
| **`MODEL_ERROR`** | 400 | `EX_USAGE` (64) | **No** | Target pointed to `/Customer/updateByColumn` instead of `/Manager/updateByColumn`. Re-route to Manager. |
| **`POISONED_PATH_500`** | 500 | `EX_USAGE` (64) | **No** | Form body contained forbidden `path` property. Strip `path` parameter fail-fast at boundary. |
| **`QUBIC_UI_ONLY_404`** | 404 | `EX_USAGE` (64) | **No** | Direct request sent to `/qubic/api/...` instead of `/cloud/api/...`. Correct URL prefix. |
| **`INVALID_IDENTIFIER_LENGTH`** | 422 | `EX_USAGE` (64) | **No** | Customer login exceeds 11 characters. Truncate or reject at boundary. |
| **`AUTHENTICATION_SESSION_EXPIRED`** | 401 | `EX_DATAERR` (72) | **Yes (1x)** | JWT expired (~20–25 min lifetime). Execute exactly 1 re-mint cycle via `authenticateCustomer` and retry request. |
| **`WIRE_PAYLOAD_TRUNCATED`** | 502 | `EX_DATAERR` (72) | **Yes** | Upstream returned malformed or truncated JSON. Retry with exponential backoff. |
| **`WIRE_PAYLOAD_SHAPE_DRIFT`** | 200 | `EX_DATAERR` (72) | **No** | Response root is non-object, missing `Result`, or contains invalid types. |
| **`CSRF_PAIRING_MISMATCH`** | 403 | `EX_NOPERM` (77) | **No** | `sessionId` and `clientCsrfToken` were not both present or both omitted. |
| **`UNSAFE_REFERRER_HEADER`** | 403 | `EX_NOPERM` (77) | **No** | Inbound request sent `referrerPolicy: unsafe-url`. Rejected to prevent `DESK-*` HMAC leakage. |
| **`TRANSPORT_TIMEOUT`** | 408 / 504 | `EX_TEMPFAIL` (75) | **Yes** | Monotonic deadline budget exceeded (`AbortSignal.timeout`). Retryable within remaining total budget. |
| **`UPSTREAM_UNAVAILABLE`** | 502 / 503 | `EX_TEMPFAIL` (75) | **Yes** | Cloudflare reverse proxy or gateway unreachable. Retry with exponential backoff and jitter. |

## 7. Complete Endpoint Reference

### `POST /cloud/api/System/authenticateCustomer`
**Authenticate Agent / Customer Session** (`operationId: /cloud/api/System/authenticateCustomer`)

Exchanges master or downline agent credentials for a scoped Bearer JWT token (~20–25 minute lifetime). Re-mint immediately if response contains HTML challenge.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Authentication successful
  - `HTTP 401`: Invalid credentials or Cloudflare challenge

### `POST /cloud/api/Manager/getBetTicker`
**Live Bet Ticker Feed (Delta Watermark Stream)** (`operationId: /cloud/api/Manager/getBetTicker`)

Ticket-per-row continuous surveillance stream. Supports delta polling using monotonic wagerNumber watermark. Ingests all 5 active WagerSource channels: Internet (L18.N0204), ALERT (L21.N0884), GSBUILDER (L22.N1402), GSLIVE (L23.N0412), CSLEVEL2 (L24.N2019).

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Ticker response envelope

### `POST /cloud/api/Manager/getBetTickerConfig`
**Bet Ticker Panel Configuration Probe** (`operationId: /cloud/api/Manager/getBetTickerConfig`)

Probes if the live bet ticker is configured for the authenticated agent scope. Returns { 'INFO': false } when inactive or misconfigured.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Configuration probe result

### `POST /cloud/api/Manager/getPending`
**Open Book Exposure Feed (Leg-per-Row Stream)** (`operationId: /cloud/api/Manager/getPending`)

Returns raw flat array of ~6,000+ open legs. Requires client-side parent ticket reconstruction keyed by Login|WagerNumber. Drops BLOCKED sentinel noise (L19.N0518) and zero-stake rows prior to parent grouping.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/json`
- **Responses**:
  - `HTTP 200`: Flat array of pending wager legs

### `POST /cloud/api/Manager/getWebLog`
**Forensic Web Access Log & IP Tracker (Observed HAR Capture v1.0.279)** (`operationId: /cloud/api/Manager/getWebLog`)

The authoritative forensic IP investigation endpoint documented in operational_guardrails_runbook.md § 5.1.1. Governed by the selector type field: A (Web Access Log velocity), B (Global IP Matcher across BILLY666 downline), C (Acct IP Match for sibling accounts), I (Users by IP reverse lookup).

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Forensic log entries

### `POST /cloud/api/Manager/search`
**Global Omnisearch Component (search-component)** (`operationId: /cloud/api/Manager/search`)

Searches both downline agent tree nodes and bettor customer accounts. Employs autocomplete='new-password' to defeat password manager autofill.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Search matching entities

### `POST /cloud/api/Manager/updateByColumn`
**Customer State Mutation (Confirmation Delays & Limit Clamps)** (`operationId: /cloud/api/Manager/updateByColumn`)

Mutates single column on customer record. Invariants: customerID must be strictly 11-character space-padded PaddedCustomerId. agentID/agentOwner must match direct owning sub-agent (never master BILLY666). Passing path poisons updateByColumn (HTTP 500 empty body).

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Mutation execution outcome
  - `HTTP 400`: Model error (Called Customer/updateByColumn instead of Manager/)
  - `HTTP 500`: Poisoned path parameter detected (empty body) or Gateway fault

### `POST /cloud/api/Manager/getInfoPlayer`
**Customer Account Inspection & Read-Back Verification** (`operationId: /cloud/api/Manager/getInfoPlayer`)

Reads live customer record to verify persistence following updateByColumn mutations via normalized Bun.deepEquals().

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Live player account attributes

### `POST /cloud/api/Manager/vigSetupInsert`
**Player Odds Shading & Vig Override Mutation (+15c / +20c)** (`operationId: /cloud/api/Manager/vigSetupInsert`)

Applies custom vigorish adjustments to sharp accounts (+15c main spreads/totals, +20c derivatives). Requires Content-Type: application/json, 20-character space-padded sportType, and 11-character space-padded player ID.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/json`
- **Responses**:
  - `HTTP 200`: Vig setup insertion confirmation

### `POST /cloud/api/Manager/getSportsVigSetup`
**Read-Back Verification for Player Vig Overrides** (`operationId: /cloud/api/Manager/getSportsVigSetup`)

Queries live vigorish configuration to verify persistence following vigSetupInsert mutations.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Configured sport vigorish profile

### `POST /cloud/api/Manager/getInfoManager`
**Master Header KPIs & Summary Balances** (`operationId: /cloud/api/Manager/getInfoManager`)

Feeds mobile and desktop header summary tiles: My Balance, Weekly figure, Today net, Active accounts, and Makeup carryover deficit.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Summary balance metrics

### `POST /cloud/api/Report/getWeeklyFigure`
**Weekly Downline Settlement Roll-Up** (`operationId: /cloud/api/Report/getWeeklyFigure`)

Triggered by data-action='get-weekly-figure'. Returns Monday-to-Sunday weekly volume, gross net won/lost, and active account totals across all sub-agents under BILLY666.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Weekly settlement figures across downline branches

### `POST /cloud/api/Report/getAgentPerformance`
**Branch Performance & Hold Rate Surveillance** (`operationId: /cloud/api/Report/getAgentPerformance`)

Triggered by data-action='get-agent-performance' (data-type='C'). Downline volume, net won, and hold percentage evaluated against the 8-tier BranchGrade hierarchy (AAA down to D_TOXIC).

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Per-agent downline performance records

### `POST /cloud/api/Report/getSettledFigure`
**Collections & 50% Settlement Liability Accounting** (`operationId: /cloud/api/Report/getSettledFigure`)

Triggered by data-action='get-settled-figure' (Collections). Audits weekly settled figures, agent 50% split accounting, and carryover makeup obligations.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Collections settlement breakdown

### `POST /cloud/api/Report/delete-wager`
**Deleted & Voided Wagers Audit Trail** (`operationId: /cloud/api/Report/delete-wager`)

Triggered by data-action='delete-wager'. Audits all voided, cancelled, and deleted tickets to investigate line-chase cancels or VOID_HEAVY_DISGUST churn.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: List of deleted and voided tickets

### `GET /health`
**SportsDesk Daemon Health & Telemetry Probe** (`operationId: /health`)

Local in-process probe verifying Bun HTTP server uptime, active port, and runtime environment.

- **Retry Policy**: `NON-RETRYABLE`
- **Responses**:
  - `HTTP 200`: Healthy daemon status

### `GET /api/watchlist`
**Active Monitored Sharp / Whale Accounts** (`operationId: /api/watchlist`)

Returns list of tracked accounts under active surveillance. Requires SPORTSDESK_ADMIN_TOKEN bearer authorization.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
- **Responses**:
  - `HTTP 200`: Monitored watch list records

### `POST /api/telegram/alert`
**Instant Telegram Alert Dispatch** (`operationId: /api/telegram/alert`)

Dispatches an urgent formatted rich alert message directly to the desk Telegram channel via @demodevdeskbot.

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/json`
- **Responses**:
  - `HTTP 200`: Alert dispatched successfully

### `POST /api/telegram/report`
**Executive Scheduled Report Trigger** (`operationId: /api/telegram/report`)

Immediately triggers and broadcasts one of the three scheduled reports: MORNING_BRIEFING (08:00 EDT), MIDDAY_STEAM (13:00 EDT), or EVENING_SETTLEMENT (23:00 EDT).

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `type` (query): `string` — 
- **Responses**:
  - `HTTP 200`: Report triggered

### `POST /api/desk/auth/session`
**Operator Desk Session Minting (CookieMap & UUIDv7)** (`operationId: /api/desk/auth/session`)

Provisions authenticated desk operator session. Sets RFC 6265 HTTP-only cookie desk_session_id using sequential UUIDv7 timestamps.

- **Retry Policy**: `NON-RETRYABLE`
- **Responses**:
  - `HTTP 200`: Session established

### `DELETE /api/desk/auth/session`
**Revoke Operator Desk Session** (`operationId: /api/desk/auth/session`)

Clears desk_session_id cookie and invalidates session token.

- **Retry Policy**: `NON-RETRYABLE`
- **Responses**:
  - `HTTP 200`: Session revoked

### `POST /api/desk/hitl/approve`
**Human-in-the-Loop Tier 2 Limit Approval (HMAC-SHA256 DESK-*)** (`operationId: /api/desk/hitl/approve`)

Executes Tier 2 limit raises or sharp overrides requiring cryptographic operator authorization. Validates DESK-* HMAC token using constant-time crypto.timingSafeEqual before dispatching Manager/updateByColumn.

- **Retry Policy**: `NON-RETRYABLE`
- **Parameters**:
  - `undefined` (undefined): `string` — 
- **Request Payload**:
  - Content-Type: `application/json`
- **Responses**:
  - `HTTP 200`: Approval confirmed and mutation committed
  - `HTTP 403`: Invalid token or unsafe referrer policy detected

### `POST /manager-tools/ajax.php`
**GS Buckeye 2 Partner 118 Steam Reference Ingestion** (`operationId: /manager-tools/ajax.php`)

Asynchronously queries Partner 118 getBetReport to resolve cross-book steam moves joined via M.G<betGroupId>. Mandates referrerPolicy: 'strict-origin'.

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Partner 118 steam ticket report

### `POST /cloud/api/System/verifySession`
**Verify Active JWT Session** (`operationId: verifySession`)

Validates active token integrity. On HTTP 401, triggers 1x re-mint cycle before failing closed.

- **Retry Policy**: `RETRYABLE`
- **Responses**:
  - `HTTP 200`: Session valid
  - `HTTP 401`: Session expired (re-mint triggered)

### `GET /api/desk/auth/me`
**Inspect Current Operator Session** (`operationId: getOperatorSession`)

Retrieves active operator session ID from HTTP-only cookies.

- **Retry Policy**: `NON-RETRYABLE`
- **Responses**:
  - `HTTP 200`: Active session confirmed
  - `HTTP 401`: Unauthenticated

### `POST /cloud/api/Manager/getCustomerNotes`
**Get Customer Risk Notes & Surveillance Annotations** (`operationId: getCustomerNotes`)

Fetches operator notes, sharp tags, and historical risk flags for a player.

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Notes retrieved

### `POST /cloud/api/Manager/updateCustomerNotes`
**Append Customer Risk Annotation** (`operationId: updateCustomerNotes`)

Appends an immutable audit annotation to the customer profile.

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Note appended

### `POST /cloud/api/Manager/deleteSportsVigSetup`
**Remove Custom Juice Shading Rules** (`operationId: deleteSportsVigSetup`)

Restores baseline odds pricing for the player by deleting active vig overrides.

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Vig setup deleted

### `POST /cloud/api/Manager/deleteWager`
**Void / Cancel Wager Ticket** (`operationId: deleteWager`)

Cancels an open or contested wager ticket with reason code audit logging.

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/x-www-form-urlencoded`
- **Responses**:
  - `HTTP 200`: Wager canceled

### `POST /cloud/api/Report/getDeletedWagerReport`
**Deleted & Voided Wagers Audit Log** (`operationId: getDeletedWagerReport`)

Audit log of all voided, deleted, and canceled tickets across the downline with operator timestamps.

- **Retry Policy**: `NON-RETRYABLE`
- **Responses**:
  - `HTTP 200`: Deleted wagers log

### `POST /cloud/api/Report/getDailyFigure`
**Daily Gross Volume & House Hold Breakdown** (`operationId: getDailyFigure`)

Pulls daily volume, payouts, and hold deficit/profit across billing period.

- **Retry Policy**: `NON-RETRYABLE`
- **Responses**:
  - `HTTP 200`: Daily breakdown

### `GET /api/desk/hitl/queue`
**Query Pending Tier 2 Limit Adjustments** (`operationId: getHitlQueue`)

Lists all queued limit modifications awaiting operator sign-off.

- **Retry Policy**: `NON-RETRYABLE`
- **Responses**:
  - `HTTP 200`: Queued approvals list

### `POST /api/desk/hitl/reject`
**Reject Queued Limit Raise** (`operationId: rejectHitlLimit`)

Rejects and purges a queued limit raise with rejection audit notes.

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/json`
- **Responses**:
  - `HTTP 200`: Queued approval rejected

### `POST /api/desk/forensics/audit`
**Dispatch Multi-Factor Forensic Audit** (`operationId: dispatchForensicAudit`)

Runs Mode A / Mode B / Mode C / Mode I scans and computes Multi-Factor Corroboration Score (MFCS 0-100).

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/json`
- **Responses**:
  - `HTTP 200`: Forensic audit scorecard

### `GET /api/desk/forensics/scores`
**Query Empirical Bayes Sharp Scores** (`operationId: getSharpScores`)

Queries online Empirical Bayes sharp scores (tau*=0.68, N_min=8) and CLV basis points.

- **Retry Policy**: `NON-RETRYABLE`
- **Responses**:
  - `HTTP 200`: Sharp scores registry

### `POST /api/desk/rfq/quote`
**Request Prediction Market RFQ Joint Probability Quote** (`operationId: requestRfqQuote`)

Translates SportsDesk sharp tickets into Polymarket / Kalshi multi-leg event contracts and queries RFQAPI for dynamic probability quotes.

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/json`
- **Responses**:
  - `HTTP 200`: Joint RFQ quote received

### `POST /api/desk/rfq/hedge`
**Execute Layoff Hedge Order** (`operationId: executeLayoffHedge`)

Dispatches hedging orders to Polymarket Combos / Kalshi to neutralize tail payout exposure.

- **Retry Policy**: `NON-RETRYABLE`
- **Request Payload**:
  - Content-Type: `application/json`
- **Responses**:
  - `HTTP 200`: Layoff hedge executed


---

## 8. Plane 3 Bitemporal Log Replay & Zero-Copy Bun.JSONL Architecture

In `sportsdesk_ingestion_replay.ts`, line updates and market odds stream into append-only JSONL files (`reports/ingestion-audit.jsonl`). To prevent timeline collisions and allow historical backtesting, the database models two orthogonal temporal dimensions:

* **Valid Time (`v_t` / `valid_from` $\to$ `valid_to`)**: When the odds or market state were factually active in the real world. Unclosed intervals default to the open sentinel `VALID_TIME_OPEN_SENTINEL` (`9223372036854775807n`, `i64::MAX`).
* **Transaction Time (`tx_from` $\to$ `tx_to`)**: When the physical record was committed to SQLite. Closed on duplicate row IDs to preserve an immutable audit trail of corrections.

```sql
-- Enforced via SQLite WAL trigger in sportsdesk_ingestion_replay.ts
CREATE TRIGGER enforce_bitemporal_overlap
BEFORE INSERT ON ingestion_trades
FOR EACH ROW
WHEN NEW.channel_status != 'DROPPED'
BEGIN
  SELECT RAISE(ABORT, 'Bitemporal Overlap on ' || NEW.channel_id)
  WHERE EXISTS (
    SELECT 1 FROM ingestion_trades
    WHERE channel_id = NEW.channel_id
      AND tx_to IS NULL
      AND NEW.valid_from < IFNULL(valid_to, 9223372036854775807)
      AND IFNULL(NEW.valid_to, 9223372036854775807) > valid_from
  );
END;
```

* **Zero-Copy ASCII Extraction**: Uses Bun's C++ JSC parser (`Bun.JSONL.parseChunk`) to stream directly from `Uint8Array` binary buffers, slicing byte offsets with `buf.subarray(result.read)` rather than allocating intermediate `TextDecoder` strings.
* **Golden XML AST Pinning**: Validates incoming odds XML structures against pre-computed SHA-256 hashes (`Bun.XML.parse(xml, { compact: false })`), detecting price anomalies:
  * `SPIKE_UP`: $\text{Price} > 1.20 \times \text{Price}_{\text{prev}}$
  * `SPIKE_DOWN`: $\text{Price} < 0.80 \times \text{Price}_{\text{prev}}$

---

## 9. Empirical Bayes Online Sharp Scoring & CLV Triangulation

Naive win-loss percentages fail because retail noise ($\approx 85\%$ of the book) pulls true sharp signals toward zero. SportsDesk regularizes player Closing Line Value (CLV) against archetype-stratified priors:

$$\text{CLV (bps)} = \left( \frac{P_{\text{bet}}}{P_{\text{close}}} - 1 \right) \times 10{,}000$$

$$\hat{\theta}_i = \frac{\frac{\mu_{\text{archetype}}}{\sigma_{\text{archetype}}^2} + \frac{N_i Y_i}{s_i^2}}{\frac{1}{\sigma_{\text{archetype}}^2} + \frac{N_i}{s_i^2}}$$

| Behavioral Archetype | Prior Mean ($\mu_0$) | Prior Variance ($\sigma_0^2$) | Min Sample Floor ($N$) | Operational Action |
| :--- | :--- | :--- | :--- | :--- |
| **`EXECUTION_SNIPER`** | $+240\text{ bps}$ | $18.5$ | $N \ge 8$ | Slash limits to $500, apply 15s delay gate. |
| **`STEAM_CHASER`** | $+160\text{ bps}$ | $24.0$ | $N \ge 12$ | Apply 4s–6s delay gate, monitor consensus lag. |
| **`PARLAY_EXTRACTOR`** | $+95\text{ bps}$ | $35.0$ | $N \ge 15$ | Restrict correlated multi-leg proposition stacking. |
| **`WHALE_VOLATILITY`** | $-140\text{ bps}$ | $65.0$ | $N \ge 20$ | Collar per-wager risk, **do not apply delay gates**. |
| **`RECREATIONAL_CASUAL`**| $-380\text{ bps}$ | $42.0$ | $N \ge 10$ | Standard limits, zero delay friction. |

* **The Whale Fallacy**: High-volume losing whales (e.g. account `RF2003` under agent `FAKEMONEY`) generate large short-term variance swings despite heavily negative CLV (-185 bps). Throttling or banning them on raw turnover destroys core house profitability.
* **The Regularization Gate ($\tau^* = 0.68, N_{\min} \ge 8$)**: If an account has fewer than 8 settled wagers, its score is locked to $\mu_{\text{archetype}}$. No punitive delay gates or limit cuts may be executed on small sample sizes.

---

## 10. Multi-Factor Corroboration Score (MFCS 0–100) & Subnet Clustering Forensics

Raw `/24` IPv4 subnet matching produces severe false positives due to Carrier-Grade NAT (CGNAT mobile pools) and university Wi-Fi. A subnet tripwire escalates to syndicate enforcement only when the composite corroboration score reaches $\ge 80$:

$$\text{MFCS} = S_{\text{subnet}} + S_{\text{time}} + S_{\text{stake}} + S_{\text{device}} + S_{\text{market}}$$

1. **Subnet Identity ($S_{\text{subnet}}$)**: Same `/24` subnet = 15 pts; exact `/32` IP match = 30 pts.
2. **Timing Synchronicity ($S_{\text{time}}$)**: Sub-500ms concurrent placement = 30 pts; sub-5s placement = 15 pts.
3. **Stake Sizing Correlation ($S_{\text{stake}}$)**: Exact off-number dollar match (e.g. $1,340 on both accounts) = 20 pts; max table limit match = 10 pts.
4. **Device Fingerprint ($S_{\text{device}}$)**: Matching Canvas hash + WebGL renderer string = 25 pts; matching User-Agent + screen resolution = 10 pts.
5. **Selection Correlation ($S_{\text{market}}$)**: Identical derivative side = 20 pts; shared cross-book `BetGroupIdentifier` (`M.G<id>`) = 30 pts.

* **$\text{MFCS} \ge 80$ (Critical Breach)**: Flags `BOT_SNIPER_FLAGGED` / `GHOST_INJECTION_CLAMPED`. The engine executes `POST /cloud/api/Manager/updateByColumn` to apply a dynamic 6s–15s delay gate (`Delay`) and freeze table limits.
* **$\text{MFCS} < 60$**: Categorized as an innocent network collision; zero restrictions are imposed.

---

## 11. Agent Co-Underwriter Governance & 8-Tier BranchGrades

Sub-agents retain up to a 50% profit/loss share on their player downlines, creating moral hazard: agents may hide sharp action, negotiate delayed weekly settlements, or conceal winning snipers behind recreational losing whales.

The engine classifies branches using half-open intervals $[min, max)$ with an explicit `D_TOXIC` override:

| Grade | Risk Level | Net Hold % Interval | Toxicity Interval | Action Playbook |
| :--- | :--- | :--- | :--- | :--- |
| **`AAA`** | Prime Citadel | $[+18.0\%, +\infty)$ | $[0, 10)$ | 0% escrow holdback; expand recreational credit. |
| **`AA`** | Core Pillar | $[+12.0\%, +18.0\%)$ | $[0, 25)$ | 0% escrow holdback; standard weekly settlement. |
| **`A`** | Retail Pool | $[+6.0\%, +12.0\%)$ | $[0, 40)$ | 5% escrow holdback; routine ticket monitoring. |
| **`BBB`** | Balanced Flow | $[+2.0\%, +6.0\%)$ | $[0, 55)$ | 10% escrow holdback; weekly sharp audit review. |
| **`BB`** | Thin Margin | $[-2.0\%, +2.0\%)$ | $[40, 70)$ | 20% escrow holdback; cap recreational limits. |
| **`B`** | Deficit Watch | $[-10.0\%, -2.0\%)$ | $[50, 80)$ | 35% escrow holdback; freeze sub-account creation. |
| **`CCC`** | Vulnerable Deficit | $[-25.0\%, -10.0\%)$ | $[65, 88)$ | 50% escrow holdback; mandate +15c juice model. |
| **`D_TOXIC`**| Inverted / Toxic | $(-\infty, +\infty)$ | $[80, 100]$ or $\text{Hold} \le -50\%$ | 100% upfront cash escrow; slash limits to $1,000. |

* **Precedence Override**: If `toxicity >= 80 || holdPct <= -50 || (holdPct < -20 && hasSharps)`, the branch unconditionally resolves to `D_TOXIC`, freezing agent commissions until resolved.


---

## 12. Tracked Operational Domains (Surveillance Radar & Bun.WebView Crawler)

The 10 previously unmapped launcher tiles from the Fantasy402 Manager dashboard are now continuously crawled and tracked in our documentation suite via `scripts/portal_tile_crawler.ts` (using native `Bun.WebView` viewport automation and `Bun.FetchSession` connection pooling):

| Launcher Tile | Category & Swatch | Target Wire Endpoint | Status | Extracted Form Inputs | Tracked L-Keys | Operational Role & Surveillance Hook |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Game Admin** | Dark Navy (`#0f2b46`) | `POST /cloud/api/Manager/gameAdmin` | `UNDER_SURVEILLANCE` | `rotationNumber`, `sportType`, `circleLimit`, `isLocked` | `L-1034`, `L-1052` | Circling games, freezing lines, locking odds on rapid pace moves. |
| **Messaging** | Dark Navy (`#0f2b46`) | `POST /cloud/api/System/getMessages` | `UNDER_SURVEILLANCE` | `recipientScope`, `subject`, `messageBody`, `priority` | `L-1055`, `L-1056` | Downline broadcasts, operator alert inbox, sharp notification dispatches. |
| **Cashier** | Slate Gray (`#6b7785`) | `POST /cloud/api/Manager/adjustBalance` | `UNDER_SURVEILLANCE` | `customerID`, `amountCents`, `transactionType`, `notes` | `L-1031`, `L-1045`, `L-1058` | Manual ledger adjustments, cash settlement, free play credit grants. |
| **Add Customer** | Slate Gray (`#6b7785`) | `POST /cloud/api/Manager/createPlayer` | `UNDER_SURVEILLANCE` | `customerID`, `agentID`, `password`, `creditLimit`, `delaySeconds` | `L-1031`, `L-1032`, `L-1040` | Bettor account provisioning under direct sub-agent hierarchy. |
| **3rd Party Limits** | Slate Gray (`#6b7785`) | `POST /cloud/api/Manager/get3rdPartyLimits` | `UNDER_SURVEILLANCE` | `providerID`, `sportCategory`, `maxLimitCents` | `L-1060`, `L-1061` | Global limit collars across external oddsmaker feeds (Don Best, Betradar). |
| **Analysis** | Cerulean Blue (`#1d84b5`) | `POST /cloud/api/Report/getAnalysis` | `UNDER_SURVEILLANCE` | `period`, `sport`, `marketCategory`, `agentID` | `L-1034`, `L-1064` | Market and sport concentration sizing (Stage 6 of surveillance lifecycle). |
| **Scores** | Sunset Orange (`#f4511e`) | `POST /cloud/api/Manager/getScores` | `UNDER_SURVEILLANCE` | `gameID`, `periodIndex`, `homeScore`, `awayScore`, `isFinal` | `L-1034`, `L-1068` | In-play game scores, period results, manual settlement overrides. |
| **Agent Admin** | Forest Green (`#2e7d32`) | `POST /cloud/api/Manager/getAgentTree` | `UNDER_SURVEILLANCE` | `masterAgent`, `commissionSplitPercent`, `creditCeiling` | `L-1032`, `L-1070` | Sub-agent tree walk across 668 nodes, 50% split governance. |
| **Billing** | Forest Green (`#2e7d32`) | `POST /cloud/api/Manager/getBilling` | `UNDER_SURVEILLANCE` | `billingWeek`, `ratePerActiveHead`, `activeAccountCount` | `L-1050`, `L-1072` | PPH software accounting across 4,665 active accounts. |
| **Settings & Rules**| Forest Green (`#2e7d32`) | `POST /cloud/api/Manager/getRules` | `UNDER_SURVEILLANCE` | `parlayMaxPayout`, `teaserTieRule`, `defaultDelaySeconds` | `L-1040`, `L-1075` | House wagering rules, teaser tie tables, parlay payout collars. |
| **Transactions** | Cerulean Blue (`#1d84b5`) | `POST /cloud/api/Report/getFinancialReport` | `UNDER_SURVEILLANCE` | `customerID`, `startDate`, `endDate`, `transactionFilter` | `L-1031`, `L-1033`, `L-1058` | Financial transaction ledger audit across players and agent nodes. |

### Crawler Automation Script

Operators and automated daemons run the surveillance crawl directly via:
```bash
bun scripts/portal_tile_crawler.ts
```
This launches the native `Bun.WebView` in-process browser, navigates to each launcher tile, auto-waits for actionability, captures JPEG proof screenshots into `reports/tile_crawler_proofs/`, and emits an audit scorecard to `reports/tile_crawler_audit.json`.
