# GS Manager CLI — contract status (blocked, capture required)

> **Status: `blocked_contract`.** There is **no verified GS HTTP contract** in this release — no
> endpoint URL, method, content type, authentication scheme, pagination rule or response schema for
> any of the six report kinds. Nothing in this document is an HTTP endpoint. Do not build a live
> adapter from it; build the capture first.

The GS Buckeye 2 / Partner 118 deliverable is a **job-orchestration CLI**, not an API client. Its
own documentation states the rule plainly:

> "Live acquisition is intentionally blocked: no GS endpoint/authentication/response contract is
> verified. Mock results are explicitly synthetic and contain no customer data."
> — `zip:README.md:3`

> "UI routes are not HTTP endpoints. No endpoint URL, method, auth scheme, Summary action,
> pagination, or upstream response schema is fabricated here." — `zip:contracts/contract-map.md:14`

Surface id: **`surface.gs-manager-cli`** (`docs/evidence/ledger.json`, tier D). Evidence package:
`scratch/docs-audit/gs-manager-cli/` (extracted from `gs-manager-cli.zip`). This file replaces the
earlier fabricated "GS steam ingestion" path that appeared in the pre-release spec; that path is
contradicted by the extract and has been removed rather than rewritten.

## 1. Six report kinds — all `blocked_contract`

The CLI exposes six report kinds. They are **report IDs in a local CLI**, and the browser routes are
SPA navigation locations. The `upstream` block for every kind is `status: blocked_contract` with
`url: null`, `method: null`, `contentType: null`, `responseSchema: null`, `authentication: null`.

| Report kind (CLI) | UI route (not an endpoint)            | Request evidence                             | Contract status                                                      |
| ----------------- | ------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `summary`         | `/manager-tools/#/reports/summary`    | SPA query parameters + visible controls only | `blocked_contract` — transport unknown                               |
| `event`           | `/manager-tools/#/reports/events`     | Navigation link only                         | `blocked_contract` — filters/response/transport unknown              |
| `player`          | `/manager-tools/#/reports/users`      | Navigation link only                         | `blocked_contract` — filters/response/transport unknown              |
| `open-bet`        | `/manager-tools/#/reports/open-bets`  | Navigation link only                         | `blocked_contract` — filters/response/transport unknown              |
| `bettor`          | `/manager-tools/#/reports/bettor`     | Navigation link only                         | `blocked_contract` — filters/response/transport unknown              |
| `last-bets`       | `/manager-tools/#/events/bet-history` | User-supplied `getBetReport` body            | `blocked_contract` — action observed; transport and response unknown |

Citations for the table: `zip:contracts/report-surfaces.md:9-16`; the `blocked_contract` upstream
blocks are at `zip:templates/endpoint-registry.json:17-24` (summary), `:73-80` (event), `:129-136`
(player), `:188-195` (open-bet), `:250-257` (bettor), `:281-292` (last-bets). `last-bets` is the only
kind with an observed `action` (`getBetReport`, `:285`); its `url`, `method`, `contentType`,
`responseSchema` and `authentication` are still `null` (`:282-291`).

> "Only Last Bets has an observed action (`getBetReport`); no transport URL, method, response shape,
> or auth mechanism has been established for any report."
> — `zip:templates/contract-verification.md:3`

## 2. The only observed artifact: one `getBetReport` request payload

This is a **user-supplied request body**, not a capture. It establishes the field names and observed
scalar types of one Last Bets request. It establishes **no transport** — no URL, no method, no
content type, no auth, no response (`zip:templates/endpoint-registry.json:281-292`).

Source: `zip:contracts/get-bet-report.observed.json:1-22`; typed reading in
`zip:contracts/gs-manager.ts:5-27`.

| #   | Field               | Observed JSON type | Observed value   | Notes                                                            |
| --- | ------------------- | ------------------ | ---------------- | ---------------------------------------------------------------- |
| 1   | `action`            | string             | `"getBetReport"` | Only constant; the spec key is `action`, not `operation`         |
| 2   | `partnerUserId`     | string             | `""`             | Empty; hash URL passes raw login (`AF12`) — see §2.1             |
| 3   | `agent`             | string             | `""`             | Empty; scope semantics unknown                                   |
| 4   | `eventId`           | string             | `""`             | Empty                                                            |
| 5   | `freeBetId`         | string             | `""`             | Empty                                                            |
| 6   | `state`             | string             | `""`             | Opaque; only empty observed                                      |
| 7   | `sId`               | string             | `"2"`            | Opaque; string, not a number                                     |
| 8   | `minVolume`         | string             | `"0"`            | String, not a number                                             |
| 9   | `maxTimeUntilScore` | string             | `"0"`            | String, not a number                                             |
| 10  | `mId`               | string             | `""`             | Empty                                                            |
| 11  | `from`              | number             | `1793250000`     | Integer — **epoch seconds**; source timezone/inclusivity unknown |
| 12  | `fromTime`          | number             | `0`              | Integer; interaction with `from` unknown                         |
| 13  | `to`                | number             | `1793422799`     | Integer epoch seconds                                            |
| 14  | `toTime`            | number             | `86399`          | Integer; boundary precision unknown                              |
| 15  | `betId`             | string             | `""`             | Empty                                                            |
| 16  | `betGroupId`        | string             | `""`             | Empty — the earlier fabricated example used `908412`             |
| 17  | `group`             | null               | `null`           | Only `null` observed; do not broaden without evidence            |
| 18  | `dateFilterBy`      | string             | `"calcTime"`     | Opaque code; hash URL also shows `betTime` (§2.1)                |
| 19  | `partnerIds`        | string             | `""`             | Empty; **does not prove tenant 118**                             |
| 20  | `period`            | string             | `"s3"`           | Opaque source code                                               |

Unknown semantics that must be resolved by capture (`zip:contracts/contract-map.md:24`): `sId="2"`,
`period="s3"`, state codes, `calcTime` meaning, blank filters, zero-string filters, omitted vs `null`
`group`, `fromTime`/`toTime` interaction, source inclusivity/precision, row identity/grain, and
partner scope. Do not insert partner `118` into `partnerIds` without capture evidence; do not treat
UI route parameters (`bot`, `partnerId`, `searchBy`, ISO date strings) as the API query encoding
(`zip:contracts/report-surfaces.md:39`).

### 2.1 Observed hash URLs — browser route state, not the request body

Two live Manager URLs have been observed for Partner 118. Both are **SPA hash state**: they do not
change the `blocked_contract` status of §1, and they are not the encoding of the `getBetReport` body
in the table above. Evidence is separated per surface below.

**`#/reports/users` — account report (7 parameters).** Observed hash URL shape:

```text
https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=<ISO>&partnerId=118&searchBy=player&text=player_AF12&to=<ISO>
```

- `bot=true` — the SPA defaults the Bot switch off, which hides bot/syndicate accounts.
- `from` / `to` — explicit ISO-8601 UTC desk-day bounds (`00:00:00`–`23:59:59` in
  `America/Chicago`), not epoch seconds.
- `text=player_<LOGIN>` — the `player_` prefix belongs to **this** filter only.
- Evidence level: **hash URL observed**; the server-side effect of each parameter is **unverified**.

**`#/events/bet-history` — live sidecar.** Observed hash URL shape:

```text
https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=<epoch s>&to=<epoch s>&toTime=86399&dateFilterBy=calcTime&t=<epoch ms>&partnerUserId=AF12
```

- `dateFilterBy` — observed as `calcTime` (settling/populating) and `betTime` (placement). Whether
  other values are accepted is unverified.
- `partnerUserId` — the **raw login** (`AF12`), _not_ `player_AF12`. This does not imply the wire body
  carries the login: the captured body leaves the field empty (§2, row 2).
- `from` / `to` — epoch **seconds**; `toTime` is an offset within the desk day, so it is `86399` on a
  normal day and `89999` / `82799` on US DST transition days (derive it, never hardcode it).
- `t` — epoch-millisecond cache-buster that must be fresh on every open.
- Evidence level: **hash URL observed**; per-parameter server-side filtering is **unverified**; the
  request that populates the grid was **not captured**, so transport (URL, method, content type,
  auth) remains **blocked / unverified**.

Restating the caveat above: hash URL parameters are **not** the API query encoding
(`zip:contracts/report-surfaces.md:39`). Nothing in this section establishes an endpoint, a method,
a content type, an auth scheme or a response shape.

## 3. CLI interfaces — local orchestration, not HTTP endpoints

The CLI is real and tested: six Node tests cover DST bounds, invalid scope/date input, schedule
deduplication, blocked live behaviour, lock exclusion and cron quoting (`zip:README.md:33-35`). It
makes **no network calls and sends no notifications**; retrieval, parsing, pagination, retry,
reconciliation and correction ingestion are not implemented (`zip:README.md:37`).

**Top-level interfaces** (`zip:src/cli.js:7-20`, `:24-58`):

| Interface                                                  | What it does                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `capabilities`                                             | Prints report IDs with `{live: false, status: "blocked_contract"}`, `apiImplemented: false` (`src/cli.js:36`) |
| `report <kind> --partner ID --date … [--mode mock]`        | Runs a report; live mode exits **2** with `blocked_contract` (`src/cli.js:37`, `README.md:23`)                |
| `jobs add/list/run/logs/enable/disable/remove/tick/unlock` | Local job store: cron template, locking, per-job logs                                                         |
| `serve`                                                    | In-process minute dispatcher using `Bun.cron`; keeps live collection blocked (`src/cli.js:27-35`)             |
| `docs`                                                     | Renders the bundled specification as terminal Markdown (`src/cli.js:26`)                                      |
| `cron print --bun <path>`                                  | Prints a cron **template**; installs nothing (`src/cli.js:38`, `README.md:27`)                                |

**Nine `jobs` subcommands** (`zip:templates/endpoint-registry.json:306-313`; dispatch at
`zip:src/cli.js:39-58`): `add`, `list`, `run`, `logs`, `enable`, `disable`, `remove`, `tick`,
`unlock`. These are local store operations. The registry marks the local interfaces
`notUpstreamEndpoints: true` (`:303-305`) and lists `capabilities()` / `acquire()` as **proposed
adapter methods**, not HTTP routes (`:314-317`).

Report IDs are kebab-case at the CLI boundary (`open-bet`, `last-bets`); earlier design documents
used underscores. Map explicitly at any future adapter boundary (`zip:contracts/contract-map.md:28`,
`zip:templates/endpoint-registry.json:318`).

## 4. What a live adapter would need before it can exist

`zip:templates/contract-verification.md:11-29` is the checklist. In short, each report must be
captured independently before acquisition is enabled:

- actual request **URL, HTTP method, content type**, provenance;
- auth/CSRF/refresh behaviour **without saving credential values**;
- response envelope, rows path, field types/nullability, unknown-field policy;
- aggregate/bet/group/leg grain, row identity, correction/regrade behaviour;
- pagination/cursor, exhaustion signal, totals and repeated-page behaviour;
- date basis, source timezone, precision, inclusivity, `fromTime`/`toTime` interaction;
- monetary precision, profit sign, hold formula, zero-denominator behaviour;
- export completeness (grouping/subtotals/selected columns) from a **nonempty** export.

The extract also fixes the security posture for any future adapter: read-only scoped credentials,
no tokens in URLs/flags/report JSON/fixtures/cron entries, no browser cookie/storage scraping,
allow-listed HTTPS origins and report actions, no auth failure turned into an empty report, and
loopback-only if a local HTTP API is ever added (`zip:contracts/api-security-spec.md:15-29`):

> "Keep live acquisition blocked until contract and critical authorization controls are verified."
> — `zip:contracts/api-security-spec.md:29`

## 5. Non-claims

- No GS endpoint, method, content type, auth scheme, pagination rule or response schema is invented
  or implied here.
- The `$`-prefixed display values on the Summary screen are **UI labels**, not evidence of currency
  precision or sign; the existing zero state is not a verified empty acquisition
  (`zip:contracts/report-surfaces.md:41-65`).
- The CLI's manifest ledger is not an ingestion checkpoint system (`zip:README.md:37`).
- No mock output contains customer data, and no live call was ever made (`zip:README.md:3`,
  `zip:README.md:37`).
