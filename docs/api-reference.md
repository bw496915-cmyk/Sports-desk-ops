# SportsDesk & Fantasy402 Production Wire API Reference

**Repository**: `Sports-desk-ops`  
**Authoritative Sources**: `operational_guardrails_runbook.md`, `bun_server_runtime_shapes_runbook.md`, `domain-branded-types.ts`, `tokens.toml`, and Manager HAR Capture (`v1.0.279`).  
**OpenAPI 3.1 Specification**: [`docs/openapi.json`](./openapi.json)

---

## 1. HTTP Headers & Transport Security Specification

All outbound requests dispatched by automation clients (Bun `fetch()`, Wrangler, and surveillance daemons) and inbound responses emitted by SportsDesk servers adhere strictly to the following transport contracts:

### 1.1 Outbound Request Headers Matrix

| Header Name | Value / Format | Requirement | Operational Rationale |
|---|---|---|---|
| **`Authorization`** | `Bearer <JWT>` | **Required** | Scoped session token minted via `authenticateCustomer`. Passing `X-JWT-Assertion` or query tokens yields HTTP 401. |
| **`X-Requested-With`**| `XMLHttpRequest` | **Required** | AJAX gateway identifier required by Cloudflare edge and OpenResty reverse proxy. |
| **`Accept`** | `application/json` | **Required** | Content negotiation enforcing JSON response envelopes over HTML challenge fallbacks. |
| **`Referrer-Policy`** | `no-referrer` | **Mandated** | Prevents internal portal URLs, account IDs, and `DESK-*` HMAC approval tokens from leaking across network hops. |
| **`Content-Type`** | `application/x-www-form-urlencoded; charset=UTF-8`<br>or `application/json` | **Per-Endpoint** | `vigSetupInsert` and `getPending` strictly require `application/json`; `updateByColumn`, `getWebLog`, and `getBetTicker` require `x-www-form-urlencoded`. |

### 1.2 Inbound Server & Edge Security Headers

Validated continuously in `tests/server_headers.test.ts` and `sportsdesk_webview_server.ts`:

* **`Content-Security-Policy`**:
  ```http
  Content-Security-Policy: frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;
  ```
  Governs Telegram Web, mobile, and desktop Mini App embedding while preventing unauthorized iframe clickjacking.
* **`X-Frame-Options` (Strictly Omitted)**:
  The deprecated `X-Frame-Options: ALLOWALL` directive is **strictly omitted** across all routes. Framing is governed exclusively by modern CSP `frame-ancestors`.
* **`X-Content-Type-Options`**: `nosniff` prevents MIME type sniffing attacks on API responses.
* **`Referrer-Policy`**: `strict-origin-when-cross-origin` protects origin privacy while retaining referrer paths for internal diagnostics.

---

## 2. Authentication & Session Lifecycles

### `POST /cloud/api/System/authenticateCustomer`
Exchanges master or agent credentials for a scoped Bearer JWT token (~20–25 minute lifetime).

* **Endpoint**: `https://www.fantasy402.com/cloud/api/System/authenticateCustomer`
* **Content-Type**: `application/x-www-form-urlencoded`
* **Payload**:
  ```
  customerID=BILLY666&password=<PASSWORD>
  ```
* **Response**: Returns `{ "code": "<JWT>", "accountInfo": { ... } }`.
* **Guardrail**: If the response returns HTML containing `<` (Cloudflare challenge or expired session), the caller must fail closed (`AUTHENTICATION_SESSION_EXPIRED`, exit code `72`) and re-mint immediately.

---

## 3. Ingestion Feeds & Surveillance

### 3.1 Live Bet Ticker: `POST /cloud/api/Manager/getBetTicker`
Continuously surveils live wagers using ticket-per-row granularity and watermark delta polling.

* **Payload**:
  ```
  agentID=BILLY666&agentOwner=BILLY666&wagerNumber=<WATERMARK>&operation=getBetTicker&RRO=1
  ```
* **Channel Ingestion Matrix (`WagerSource` from `tokens.toml`)**:
  * `Internet` (`L18.N0204`, `#1d84b5`): Retail pregame baseline (1,500 ms SLA).
  * `ALERT` (`L21.N0884`, `#ef4444`): Syndicate sub-account mirror (250 ms SLA). Buffered with `canonicalVolumeCents = 0`.
  * `GSBUILDER` (`L22.N1402`, `#f59e0b`): Same-game prop builder (1,000 ms SLA). Joined via `M.G<betGroupId>`.
  * `GSLIVE` (`L23.N0412`, `#28a745`): Live in-play whale anomaly (500 ms SLA). Forces `LIVE` grade, `+20c` tax.
  * `CSLEVEL2` (`L24.N2019`, `#38bdf8`): Recreational longshot bias feed (2,000 ms SLA).

### 3.2 Bet Ticker Config Probe: `POST /cloud/api/Manager/getBetTickerConfig`
Checks whether the bet ticker feed is active for the current agent context. Returns `{"INFO": false}` when inactive.

### 3.3 Open Book Exposure: `POST /cloud/api/Manager/getPending`
Ingests open book wagers across ~6,000+ flat leg rows.

* **Content-Type**: `application/json`
* **Parent Ticket Key (`TicketIdentifier`)**: Reconstructs multi-leg cards by composite key `${Login.trim()}|${WagerNumber}`.
* **Noise Filter**: Unconditionally drops rows where `TicketWriter === "BLOCKED"` (`L19.N0518`) or `Amount === 0 && Risk === 0`.
* **Wager Type Normalization (`ShortDesc[0]`)**:
  * `S`: Straight (`SPREAD` / `TOTAL` / `MONEYLINE`)
  * `P`: Parlay (multi-leg card; `Risk` repeats across all leg rows)
  * `L`: Single line / player proposition
  * `C`: Prop-builder / futures (`M.G<betGroupId>`)
  * `T`: Class T Teaser (`canonicalVolumeCents = null`)
  * `G` / `M`: Live in-play derivative (`GSLIVE` / `GSBUILDER`)
  * `E`: Exotic / alternate single feed

---

## 4. Forensic Surveillance & Access Logs

### 4.1 Forensic Web Access Log: `POST /cloud/api/Manager/getWebLog`
The authoritative wire contract for forensic IP surveillance observed in Manager HAR capture `v1.0.279` (`operational_guardrails_runbook.md` § 5.1.1).

* **Content-Type**: `application/x-www-form-urlencoded; charset=UTF-8`
* **Observed Wire Payload**:
  ```
  agentID=BILLY666&customerID=0&start=10/28/2026&end=10/28/2026&type=B&actions=ALL&ip=&operation=getWebLog&RRO=1&agentOwner=BILLY666
  ```

| Mode (`type`) | Action Name | Query Target | Forensic Utility |
|---|---|---|---|
| **`A`** | **Web Access Log** | Chronological session access | Calculates session-to-wager velocity ($\Delta t < 15\text{s}$) to flag automated snipers. |
| **`B`** | **Global IP Matcher** | Entire downline scan | Detects cross-agent and cross-branch IP collisions across all 668 sub-agents under `BILLY666`. |
| **`C`** | **Acct IP Match** | Single-bettor sibling search | Traces sibling accounts sharing IP history with a designated target. Sends dates as `YYYY-MM-DD`. |
| **`I`** | **Users by IP** | Reverse IP lookup | Resolves all usernames authenticating from a specific `/24` subnet or `/32` IP address. |

### 4.2 Global Omnisearch: `POST /cloud/api/Manager/search`
Resolves target accounts and downline nodes. Uses `<input autocomplete="new-password">` to prevent browser password managers from poisoning searches.

---

## 5. State Mutations & Odds Shading

### 5.1 Customer Column Updates: `POST /cloud/api/Manager/updateByColumn`
Executes single-column updates on customer records (e.g., confirmation delays and limit cuts).

* **Content-Type**: `application/x-www-form-urlencoded`
* **Space-Padded ID Invariant (`PaddedCustomerId`)**:
  `customerID` must be strictly right-space-padded to **11 characters** (`CB112_1    `). Passing unpadded bare logins yields `Result: 0` (`SILENT_NO_OP`).
* **Sub-Agent Hierarchy**: `agentID` and `agentOwner` must be bound to the direct owning sub-agent (`CUB22HR`, `MAX92`), never master `BILLY666` (which causes `REJECTED_SCOPE`).
* **Poisoned Path Guard**: Never include a `path` parameter; doing so returns an empty HTTP 500 body.
* **Payload**:
  ```
  operation=updateByColumn&customerID=CB112_1++++&agentID=CUB22HR&agentOwner=CUB22HR&columnName=confirmationDelaySeconds&type=0&value=6&title=confirmationDelaySeconds&information=&special=&RRO=1
  ```

### 5.2 Odds Shading: `POST /cloud/api/Manager/vigSetupInsert`
Applies custom vigorish adjustments to sharp accounts (+15c main spreads/totals, +20c derivatives).

* **Content-Type**: `application/json`
* **Sport Padding**: `sportType` must be 20-character space-padded matching customer admin sequences (`"Football            "`).
* **Payload**:
  ```json
  {
    "operation": "vigSetupInsert",
    "sportType": "Football            ",
    "allPlayers": "off",
    "agentProfile": 0,
    "player": "CB112_1    ",
    "flagVig": "Y",
    "flagDiscount": "N",
    "VigSpread": "15",
    "VigTotal": "15",
    "VigDerivative": "20",
    "VigDiscountPercent": "0",
    "RRO": "1"
  }
  ```
* **Read-Back Verification**: Verified via `POST /cloud/api/Manager/getSportsVigSetup` with `Bun.deepEquals()`.

---

## 6. Downline Reporting & Settlement Roll-Ups

* **`POST /cloud/api/Manager/getInfoManager`**: Ingests header KPIs (`balance`, `grand-total-weekly`, `grand-total-day`, `grand-total-player`, `distribution` Makeup).
* **`POST /cloud/api/Report/getWeeklyFigure`**: Weekly Monday-to-Sunday handle, gross win/loss, and settlement balance roll-ups.
* **`POST /cloud/api/Report/getAgentPerformance`** (`data-type="C"`): Downline volume and hold percentage evaluated against the 8-tier BranchGrade hierarchy (`AAA` to `D_TOXIC`).
* **`POST /cloud/api/Report/getSettledFigure`**: Weekly collections and 50% agent liability accounting.
* **`POST /cloud/api/Report/delete-wager`**: Audit log of voided and cancelled tickets.

---

## 7. Local Desk Gateway & Telegram Alert Routes

Operates in-process under native `Bun.serve` on port 4020:

* **`GET /health`**: Telemetry probe returning runtime (`Bun v1.4.4`), port, and uptime.
* **`GET /api/watchlist`**: List of sharp/whale accounts under surveillance. Requires `SPORTSDESK_ADMIN_TOKEN`.
* **`POST /api/telegram/alert`**: Dispatches immediate rich HTML alerts via `@demodevdeskbot`.
* **`POST /api/telegram/report`**: Triggers scheduled reporting cards (`MORNING_BRIEFING`, `MIDDAY_STEAM`, `EVENING_SETTLEMENT`).

---

## 8. Desk HITL Security & Cryptographic Approvals

* **`POST /api/desk/auth/session`**: Sets HTTP-only `desk_session_id` using sequential UUIDv7 timestamps with 8-hour operator shift expiration.
* **`POST /api/desk/hitl/approve`**: Human-in-the-Loop Tier 2 limit approval gate. Verifies HMAC-SHA256 token (`DESK-*`) using constant-time `crypto.timingSafeEqual` before committing `Manager/updateByColumn`.

---

## 9. Cross-Book Steam Reference: GS Partner 118

* **`POST https://plive.sportswidgets.pro/manager-tools/ajax.php`**:
  * Action: `operation=getBetReport` with `referrerPolicy: "strict-origin"`.
  * Joined via `BetGroupIdentifier` (`M.G<digits>`).
  * Computes reference steam lag: $\Delta\tau_k^{\text{steam}} = \tau_k - t_{\text{ref}}^{\text{move}}$ against Pinnacle.
