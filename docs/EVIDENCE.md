# Evidence standard — SportsDesk & Fantasy402 docs release

Machine-readable source of truth: [evidence/ledger.json](./evidence/ledger.json). Capture plan:
[evidence/capture-requests.md](./evidence/capture-requests.md). Missing-surface inventory:
[evidence/surfaces.md](./evidence/surfaces.md).

This file exists because a prior audit found fabricated and overclaimed contracts in the published docs.
The rule for this release is simple: **a claim is only presented as a contract when an artifact supports
it.** Everything else is labelled as observed, inferred or unimplemented — in the spec and in the markdown.

---

## Legend

| Tier  | Meaning                                                                                                                                                                            | Count      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **A** | Captured wire contract: a real request **and** a real response capture exist.                                                                                                      | 0          |
| **B** | Observed first-party evidence: captured wire request, observed request payload, or a route this repo serves verified against its handler source. Response may still be uncaptured. | 7          |
| **C** | Inferred only: authored in the spec/generators, a repo TypeScript wire type, or a UI/DOM observation whose URL+method is a candidate. No request or response observed.             | 31         |
| **D** | A real surface missing from the spec. Recorded in `surfaces[]`, never in `operations[]`.                                                                                           | 7 surfaces |
| **E** | Documented operation with no implementation in this repository.                                                                                                                    | 10         |

**Operations:** 48 rows = 47 paths (the spec has 47 paths / 48 operations because
`/api/desk/auth/session` carries both `POST` and `DELETE`). A 0 + B 7 + C 31 + D 0 + E 10 = 48.
**Surfaces:** 8 rows (D 7, E 1). Surface counts are kept separate from operation counts.

**Tier A is empty by construction, not by omission.** A requires a captured response body. No response
body exists anywhere in the repository or the GS extract, so the strongest row (the 2026-10-28 Manager HAR
`getWebLog` mode-B request) is tier B even though its request side is fully captured.

**B-vs-C rule for the 11 "Tracked Operational Domains" candidates.** A launcher tile is not enough for B.
B requires a URL+method observed on the wire (or a handler that serves it). The 11 candidates take their
path+method from hand-authored `candidateEndpoint`/`candidateMethod` constants
(`scripts/portal_tile_crawler.ts:40-162`, `scripts/append_tracked_domains.mjs:22-228`); the crawler CLI entry
runs its offline-simulation branch (`portal_tile_crawler.ts:168`) and its live branch only replaces
extracted inputs/L-keys, never the URL or method; no audit JSON or screenshot proof exists in the tree.
They are therefore **C with `candidate_url: true`**, not B. `getAnalysis` and `getFinancialReport` also have
independent UI action-name evidence (`runbook:166-167`), but the URL is still unobserved.

---

## What is actually verified

**Captured on the wire (request side only), 2026-10-28 Manager HAR, portal `v1.0.279`:**

1. `POST /cloud/api/Manager/getWebLog`, mode B. Exact request line, headers, and form body:
   `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`, `X-Requested-With: XMLHttpRequest`,
   `agentID=<session>&customerID=0&start=10%2F28%2F2026&end=10%2F28%2F2026&type=B&actions=ALL&ip=&operation=getWebLog&RRO=1&agentOwner=<session>`
   (`operational_guardrails_runbook.md:129-140`). **No response body.**
2. `POST /cloud/api/Manager/getInfoPlayer`: the read sent a **7-character trimmed** `customerID`, and
   `agentID`/`agentOwner` were the logged-in master on all 19 Manager calls in the capture
   (`operational_guardrails_runbook.md:213-214`). **No response body.**

**Verified against implementation** (the route exists and its handler defines the contract — no HTTP
capture needed): `GET /health`, `GET /api/watchlist`, `POST /api/telegram/alert`,
`POST /api/telegram/report`. The handler source is `sportsdesk_webview_server.ts`; see
[surfaces.md](./evidence/surfaces.md) for the daemon routes the spec omits.

**Observed, not verified:** the Manager search UI component (`runbook:205-209`); the Reporting action names
`get-agent-performance` with `data-type="C"`, `get-settled-figure`, `delete-wager`, `get-analysis`,
`get-transaction-history` (`runbook:157-168`); the GS `getBetReport` request payload
(`zip:contracts/get-bet-report.observed.json`); the 11 launcher tiles.

**Inferred — everything else:** all other request bodies, all response schemas, all status codes, all
auth mechanisms except "the one observed Manager session is cookie-based", and the entire `/api/desk/*`
surface (which has no implementation at all).

---

## Contradictions (spec claim vs. concrete artifact)

Three operations carry `contradicted: true` in the ledger. The quotes are the evidence, not paraphrase.

### 1. `POST /cloud/api/Manager/getWebLog` — response schema and auth

The spec requires an `Authorization` Bearer header (`docs/openapi.json:386` →
`components/parameters/AuthBearer` at `docs/openapi.json:3091-3099`) and publishes a four-field response
schema (`customerID`, `ipAddress`, `timestamp`, `agentOwner`; `docs/openapi.json:493-519`).

> "The session is cookie-based (the capture has no `Authorization` header), and the response body was not
> captured, so the row schema is still undocumented."
> — `operational_guardrails_runbook.md:153`

The request side is real; the auth claim and the response schema are not. Modes A, C and I are also
unobserved — only mode B was captured (`runbook:131`).

### 2. `POST /manager-tools/ajax.php` — the entire GS contract

The spec publishes a POST endpoint, a form-urlencoded body requiring `operation`/`betGroupId` (example
`908412`), and a four-property response `{betGroupId, market, steamLagMs, pinnacleReferencePrice}`
(`docs/openapi.json:1881-1943`). The GS extract forbids exactly that:

> "Live acquisition is intentionally blocked: no GS endpoint/authentication/response contract is verified."
> — `zip:README.md:3`

> "No endpoint URL, method, auth scheme, Summary action, pagination, or upstream response schema is
> fabricated here." — `zip:contracts/contract-map.md:14`

> "No response capture exists: assigning invented response properties is prohibited." — `zip:contracts/gs-manager.ts:29-30`

> Last Bets upstream block: `status: blocked_contract`, `url: null`, `method: null`, `contentType: null`,
> `responseSchema: null`, `authentication: null`. — `zip:templates/endpoint-registry.json:281-288`

> "Only Last Bets has an observed action (`getBetReport`); no transport URL, method, response shape, or auth
> mechanism has been established for any report." — `zip:templates/contract-verification.md:3`

The only observed artifact is a user-supplied request payload (`zip:contracts/get-bet-report.observed.json`)
whose key is `action` (not `operation`), whose `betGroupId` is empty (not `908412`), and which carries 20
fields rather than 2.

### 3. `POST /cloud/api/Manager/getInfoPlayer` — padded-ID example (example-level)

The spec's request example is the 11-character padded `"CB112_1    "` (`docs/openapi.json:765-772`), while
the observed read sent a 7-character trimmed ID (`operational_guardrails_runbook.md:213`). The response
schema is also unpublished (`runbook:214`). This one is flagged example-level: the response semantics, not
just the example, still need a capture.

---

## GS live acquisition is blocked

The GS Buckeye 2 Partner 118 deliverable does not have a wire contract, by design. No endpoint, method,
content type, authentication mechanism, pagination or response schema for any GS report has been verified.
The CLI is real (orchestration, job store, cron template, 6 passing Node tests); the live adapter is not.
Any docs text that presents a GS HTTP contract — including `POST /manager-tools/ajax.php` — must be removed
or rewritten as "blocked, capture required". See [evidence/capture-requests.md](./evidence/capture-requests.md) §P4.

---

## Surfaces missing from the spec (D/E)

| Id                                     | Tier | What it is                                                                                                    |
| -------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `surface.fantasy402-sport-catalog`     | D    | 19 sports / 230 sub-sports / 42 period menus / 2 desk-link collision ids / 4 digests, `capturedAt 2026-10-21` |
| `surface.manager-getHistory`           | D    | Wired settlement-history poll: `POST {base}/cloud/api/Manager/getHistory`                                     |
| `surface.manager-getGrading`           | D    | Declared settlement feed; no fetch client exists ("wired" is a type/config claim only)                        |
| `surface.daemon-dashboard`             | D    | `GET /` and `GET /dashboard` dashboard HTML                                                                   |
| `surface.daemon-miniapp`               | D    | `GET /miniapp` Telegram Mini App HTML                                                                         |
| `surface.daemon-telegram-admin-routes` | D    | Webhook, telegram status/activity, preflight, error trigger                                                   |
| `surface.gs-manager-cli`               | D    | 6 report kinds + 9 `jobs` subcommands + CLI orchestration, all `blocked_contract`                             |
| `surface.desk-api-unimplemented`       | E    | 9 paths / 10 operations under `/api/desk/*` with no handler anywhere                                          |

Full inventory with evidence: [evidence/surfaces.md](./evidence/surfaces.md).

---

## Spec integrity notes for the generator

1. **Dangling security scheme.** 24 operations declare `security: [{ "BearerAuth": [] }]` and many reference
   `#/components/parameters/AuthBearer`, but `components.securitySchemes` is absent from
   `docs/openapi.json`. OpenAPI 3.1 needs the scheme declared, and `runbook:153` suggests the real Manager
   auth is a cookie. Resolve with the P3 capture before publishing a Bearer scheme.
2. **The 11 `Tracked Operational Domains` rows publish no `requestBody`.** Their `x-extracted-inputs` are DOM
   form-field names, not wire parameters. Do not render them as request schemas.
3. **Markdown overclaims to fix.** `docs/api-reference.md:693` labels the candidate paths "Target Wire
   Endpoint"; `:691` says the tiles are "now continuously crawled and tracked" and calls them "the 10
   previously unmapped launcher tiles" while the table has 11 rows. The crawler defaults to offline
   simulation and no crawl artifacts exist.
4. **`getWebLog` title.** The spec calls it "Observed HAR Capture v1.0.279"; the observed part is the
   request, not the response.

---

## Limitations (quotable paragraph for the docs generator)

> The ledger distinguishes captured wire evidence from observation and inference: no operation in this
> release has a captured response body, so every response schema here is authored unless its row says
> otherwise. The only real wire artifact is the 2026-10-28 Manager HAR request capture (portal v1.0.279),
> which recorded one `getWebLog` mode-B request and the `getInfoPlayer` read request but no response
> bodies; `getWebLog` modes A, C and I and the `getWebLog` response/auth shape remain unverified. GS
> Buckeye 2 Partner 118 live acquisition is blocked by design — no endpoint, method, authentication
> mechanism or response contract for any GS report has been verified, and the observed `getBetReport`
> payload does not establish a transport. The 11 "Tracked Operational Domains" entries are UI/DOM
> declarations with candidate URLs and methods, not wire contracts, and the `/api/desk/*` routes are
> documented without any implementation. Treat any schema or behaviour not marked tier B as a proposal to
> be confirmed by capture, not as a contract.
