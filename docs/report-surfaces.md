# GSLive Manager report surfaces — what operators can open

Operator-facing map of the two GSLive Manager (Partner 118) browser surfaces this desk links to.
Both are **SPA hash routes in a third-party console**. Neither is an endpoint of this repo, and
neither has a verified wire contract.

Generate every per-account link with `./bin/dx gslive <LOGIN>`; see the surface section with
`./bin/dx docs gslive`. The blocked-contract status and the one observed `getBetReport` payload live
in [gs-manager-contracts.md](./gs-manager-contracts.md).

> Naming note: the citations `zip:contracts/report-surfaces.md:*` in
> [gs-manager-contracts.md](./gs-manager-contracts.md) point at the extracted GS zip, not at this
> file. This page is the repo-side operator summary.

## Surfaces at a glance

| Surface               | Route                                            | Answers                                                                     | Evidence level                                                                                  |
| :-------------------- | :----------------------------------------------- | :-------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| Account report        | `#/reports/users`                                | Profit, bets, hold %, wager and leg counts for one player over a day window | **Hash URL observed**; server-side filter behaviour **unverified**                              |
| Live settling stream  | `#/events/bet-history` (`dateFilterBy=calcTime`) | Tickets as they settle/populate for the current desk day                    | **Hash URL observed**; per-parameter filtering **unverified**; **transport blocked/unverified** |
| Live placement stream | `#/events/bet-history` (`dateFilterBy=betTime`)  | Tickets as they are placed                                                  | **Hash URL observed**; per-parameter filtering **unverified**; **transport blocked/unverified** |

“Hash URL observed” means an operator URL was seen in the browser. It does **not** mean the request
that fills the grid was captured, and it says nothing about URL, method, content type, auth or
response shape of the underlying call.

## `#/reports/users` — 7-parameter deep link

```text
https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=<desk-day start ISO>&partnerId=118&searchBy=player&text=player_<LOGIN>&to=<desk-day end ISO>
```

- **`bot=true` is mandatory.** The SPA defaults the Bot switch off, which hides bot/syndicate
  accounts (`player_CHURN_003`, `player_NOISE_BOT_77`).
- **`from` / `to` are explicit ISO-8601 UTC desk-day bounds** — `00:00:00` to `23:59:59` in
  `America/Chicago`. Without them the grid renders empty or stale. They are ISO strings here, not
  epoch seconds.
- **`text=player_<LOGIN>`.** The `player_` prefix belongs to this filter only.
- **`partnerId=118`**, `searchBy=player`, `eventId=` (empty for an account view).
- **Evidence:** hash URL observed. Whether each parameter actually filters server-side is
  unverified — confirm by the row count in the grid.

## `#/events/bet-history` — live sidecar

```text
https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=<epoch s>&to=<epoch s>&toTime=<desk day length - 1>&dateFilterBy=calcTime&t=<epoch ms>&partnerUserId=<LOGIN>
```

- **`dateFilterBy=calcTime`** follows settlement/population (the stale-line note and the cancel).
  **`dateFilterBy=betTime`** follows placement and placement tempo.
- **`from` / `to` are epoch seconds** for the desk-day start (not ISO strings).
- **`toTime` is a DST-aware offset** to the last second of the desk day: `86399` normally, `89999`
  on the 25-hour fall-back day, `82799` on the 23-hour spring-forward day. Derive it; never
  hardcode it.
- **`t` is an epoch-millisecond cache-buster** and must be fresh on every open. A frozen value
  serves a cached grid.
- **`partnerUserId` is the raw login** (`AF12`), not `player_AF12`. The prefix belongs to
  `#/reports/users?text=` only. Do not read this as proof of the wire field: the one observed
  `getBetReport` body leaves `partnerUserId` empty.
- **`minVolume=0` / `maxTimeUntilScore=0`** disable volume and score-time filtering.
- **Evidence:** hash URL observed. Per-parameter server-side filtering is unverified — confirm by
  row count, and filter in the console if the grid is not narrowed. The transport that populates the
  grid was **not captured**, so it stays **blocked/unverified**.

## What this page does not establish

- No endpoint URL, method, content type, auth scheme or response schema for any surface. Acquisition
  remains `blocked_contract`; see [gs-manager-contracts.md](./gs-manager-contracts.md) §1 and §4.
- No wire contract: hash parameters are **route state**, not the API query encoding.
- No claim that `partnerUserId`, `eventId`, `bot`, `searchBy` or the ISO bounds are honoured by the
  server. Only the rendered grid is evidence.

Related: [OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md](./OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md)
for when to use each surface, and [EVIDENCE.md](./EVIDENCE.md) for the tier model.
