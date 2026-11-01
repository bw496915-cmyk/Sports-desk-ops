# Synthetic backtest fixture (P1.1)

This directory holds a **synthetic** input pair for
`lib/parlay_combo_backtest_engine.ts`. Nothing here is captured customer
behaviour and nothing was copied from the gitignored demo book
(`enriched_customers_full.json`, `sportsdesk_downline_data.json`).

The real repo root is not needed: the engine takes a `repoRoot` argument and
only ever reads two file names under it, so a test can point it here.

```ts
runFourWeekParlayComboBacktest("/absolute/path/to/tests/fixtures/backtest");
```

## Files

| File                                  | Role                                                                          |
| :------------------------------------ | :---------------------------------------------------------------------------- |
| `enriched_customers_full.json`        | 6 synthetic accounts / 9 tickets; drives the per-customer row derivation.     |
| `sportsdesk_downline_data.json`       | `meta.total_provisioned_accounts = 41`, `active_sports_bettors = 7`.          |
| `expected-fixture-report.golden.json` | Committed expectation for the fixture-driven run (headline, dataBasis, rows). |

`enriched_customers_full.json` is the file name the engine hard-codes, so it has
to keep its name even though this is a fixture.

## What the fixture covers

Accounts are deliberately small and marked `SYNTH_*`; IPs use the reserved
documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) and
wager numbers are `990xxx`, so a stray copy is obvious.

- `SYNTH_SYN_01` — sharp via `lifetime_net / lifetime_volume = -15%`; 2 CFB + 1
  NBA ticket; one ticket has an empty `placed_at` (filtered out of the sampled
  window); `sports_7d_volume_usd / 5` sets the handle.
- `SYNTH_SNIPER_02` — sharp via `clv_bps = 120`; `sports_7d_volume_usd = 0`
  exercises the `|| 5000` fallback; one NFL ticket proves non-CFB/NBA leagues
  are ignored.
- `SYNTH_REC_03` — recreational path (`hold_pct` null because
  `lifetime_volume_usd = 0`); empty `recent_tickets` array.
- `SYNTH_REC_04` — recreational path with **no** `recent_tickets` key at all;
  falls back to the default `lastActiveAt`.
- `PEY101` — id present in the committed `CUSTOMER_TO_POLY_WALLET` map, not in
  the curated featured list, so it exercises the wallet-link branch
  (`proxyWallet` / `polymarketProfileUrl` / `polymarketPositionsApiUrl`).
  The row data is synthetic; only the id is reused to reach that branch.
- `BGD101` — duplicate of a curated featured account with deliberately absurd
  numbers; the engine must skip it, so the featured row is unchanged.

Not covered here (only reachable with the full book, still asserted by the
local-run tests):

- the 36-row cap that skips `RECREATIONAL_CASUAL` rows;
- the 9,435 / 1,100 / 220 / 22 headline numbers.

## Scenario constants

`weeklyBreakdown`, `comboFamilyBreakdown`, `guardAttribution` and the aggregate
P&L are scenario constants inside the engine, not sums over the book. They are
identical for any input, so CI pins them against the committed
`docs/backtest-4wk-cfb-nba.json` instead of duplicating them here.

## Regenerating the golden

```sh
BACKTEST_FIXTURE_UPDATE_GOLDEN=1 bun test tests/parlay_combo_backtest_engine.test.ts
```

Review the diff before committing it; the golden only moves when the engine's
fixture-driven derivation changes.
