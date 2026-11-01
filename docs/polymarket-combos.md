# Polymarket CFB combos — discovery, pricing and uniqueness

Operator and engineering notes for CFB combo work. Public APIs only; no key.

## 1. What is verified

| Surface `[OBSERVED]`      | Endpoint                                                                                                                 | Evidence                                                                                         |
| :------------------------ | :----------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| CFB events / legs         | `GET gamma-api.polymarket.com/events?series_id=12756&active=true&closed=false&order=volume24hr&ascending=false&limit=50` | Live 2026-10-31: 50 events, ML/spread/total markets with `outcomes`/`outcomePrices` JSON strings |
| Combo positions           | `GET data-api.polymarket.com/v2/positions/combos?user=<0x>`                                                              | Live 2026-10-31: `{data, pagination}`, nested `legs[].market`                                    |
| Combo activity            | `GET data-api.polymarket.com/v2/activity/combos?user=<0x>`                                                               | Live 2026-10-31: `{data, pagination}`                                                            |
| Wallet seed (trades)      | `GET data-api.polymarket.com/trades?market=<conditionId>&limit=100`                                                      | Live 2026-10-31: array with `proxyWallet`                                                        |
| Wallet seed (leaderboard) | `GET data-api.polymarket.com/v2/leaderboard?time_period=week                                                             | month                                                                                            | all&sort_by=PNL&limit=100` | Live 2026-10-31: `{data:[{user_id,...}], pagination}` |

`lb-api.polymarket.com` is **retired** (HTTP 410, `[OBSERVED]` 2026-10-31). Do not use it.

No global CFB combo feed was exposed by the endpoints probed on 2026-10-31. Treat that as
`[UNVERIFIED]` for any endpoint added later: discovery is user-anchored — seed wallets, then query
their combo endpoints.

## 2. Product-of-legs pricing

`[CODE]` For independent legs (different games):

```
fairPrice = p1 × p2 × … × pn          (decimal probabilities, 0–1)
shares    = stake / fairPrice
payout    = shares × $1                (binary share)
```

| Example               | Fair price | $10 payout | Multiple |
| :-------------------- | :--------- | :--------- | :------- |
| 2-leg 38¢ + 80¢       | 30.4¢      | $32.89     | 3.29×    |
| 3-leg 60¢ + 55¢ + 50¢ | 16.5¢      | $60.61     | 6.06×    |

A quote above fair is the maker's margin:

```
makerMarginPct = (quotedPrice / fairPrice - 1) × 100
```

38¢ + 80¢ at a 32¢ quote is `+5.26%` over fair, and the $10 payout drops from $32.89 to $31.25.

Caveats:

- Leg prices include vig; the product is not a devigged probability.
- Same-game legs are correlated; the product overstates or understates the true price. The CLI
  prices whatever legs you pass; it does not model correlation.
- Prices outside `(0,1)` are rejected; settled legs (0/1) are not quotable.

## 3. Commands

```bash
# list upcoming CFB legs (skips started games; --include-started to include)
./bin/dx combo legs --limit 10

# price a combo from prices, with an optional quote
./bin/dx combo price --prices 0.38,0.80 --stake 10 --quoted 0.32

# price a combo from market slugs + outcomes (resolved against CFB events)
./bin/dx combo price --legs "cfb-fl-ga-2026-10-31=Georgia,cfb-nd-navy-2026-10-31=Notre Dame"

# a wallet's combo positions/activity
./bin/dx combo wallet 0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612

# three gates: permissive → all-legs-cfb → full-game
./bin/dx combo uniqueness --seed-trades --max-seed-markets 20 --limit-games 20
./bin/dx combo uniqueness --all-legs-cfb --json
./bin/dx combo uniqueness --strict-full-game --json
./bin/dx combo uniqueness --all-legs-cfb --json                    # active+closed (default)
./bin/dx combo uniqueness --open-only --since 2026-10-01 --json     # narrow view

# empirical subset chain, in one process: full-game ⊆ all-legs-cfb ⊆ permissive
./bin/dx combo verify-subset --chain --wallet-file scratch/seed.txt
./bin/dx combo verify-subset --against all-legs-cfb --wallet-file scratch/seed.txt
./bin/dx combo verify-subset --chain --strict-exit   # exit 2 on a vacuous edge (CI)

# file-based equivalent for comm
./bin/dx combo uniqueness --seed-trades --max-seed-markets 20 --limit-games 20 --dump-wallets scratch/seed.txt
LEADERBOARD=0 WALLET_FILE=scratch/seed.txt ./bin/dx combo uniqueness --limit-games 20 --all-legs-cfb --emit-ids scratch/cfb.txt
LEADERBOARD=0 WALLET_FILE=scratch/seed.txt ./bin/dx combo uniqueness --limit-games 20 --strict-full-game --emit-ids scratch/strict.txt
comm -23 <(LC_ALL=C sort scratch/strict.txt) <(LC_ALL=C sort scratch/cfb.txt)
```

`--emit-ids` writes sorted `comboId|wallet` lines for kept combos; `--dump-wallets` writes the
sorted unique wallet set. An empty result set produces an **empty file**, not a blank line (a blank
line would make `comm` report a phantom leak).

`uniqueness` options: `--fresh` (ignore cache), `--cache-dir`, `--cache-ttl-hours` (default 24),
`--no-leaderboard`, `--leaderboard-limit`, `--seed-trades`, `--max-seed-markets`, `--wallet-file`,
`--strict-full-game`, `--limit-games`, `--max-combo-pages`.

### Environment knobs

CLI flags win over environment, which wins over defaults.

| Variable               | Default                   | Effect                                                               |
| :--------------------- | :------------------------ | :------------------------------------------------------------------- |
| `CACHE_TTL_HOURS`      | `24`                      | Cache age before a wallet is refetched; `0` disables reuse           |
| `CACHE_DIR`            | `scratch/cfb-combo-cache` | Cache location                                                       |
| `FRESH`                | unset                     | `1` ignores the cache for this run                                   |
| `STRICT_FULL_GAME`     | unset                     | `1` enables the `full-game` gate (all-legs-CFB **and** single game)  |
| `INCLUDE_CLOSED_GAMES` | enabled                   | `0` = open-only index (`--open-only`); default indexes active+closed |
| `ALL_LEGS_CFB`         | unset                     | `1` enables the `all-legs-cfb` gate (CFB-only, cross-game allowed)   |
| `SEED_TRADES`          | unset                     | `1` seeds wallets from sampled CFB trades                            |
| `CONCURRENCY`          | `6`                       | Wallet fetch parallelism                                             |
| `LEADERBOARD`          | enabled                   | `0` skips leaderboard seeding                                        |
| `LEADERBOARD_LIMIT`    | `100`                     | Rows per leaderboard period                                          |
| `MAX_SEED_MARKETS`     | `60`                      | Condition IDs sampled by the trade seeder                            |
| `WALLET_FILE`          | unset                     | Extra wallet addresses (whitespace-separated)                        |

## 4. Uniqueness semantics

- A combo is attributed to a game by, in order: `leg_condition_id` / `conditionId` (including
  `market.condition_id`), `market.slug` / `market_slug`, then CLOB token id.
- A combo spanning N games is counted once in **each** of those games, so
  `sum of per-game combos ≥ distinct combos (global)`.
- Dedupe runs twice: first on `comboId|wallet`, then on `legSignatures|wallet`, where a leg
  signature is `legKey|outcome|marketType`. The second pass catches the same combo surfaced by
  two indexers with different ids; it does **not** collapse two combos that share a condition id
  but differ by outcome or market type.
- `comboId` falls back to a SHA-256 of the sorted leg signatures.
- `--strict-full-game` is a **pure gate applied after attribution**, never inside it. Every strict
  result is therefore a subset of the permissive result, and `fullyWithinGame` is identical in both
  modes. `--json` exposes `gate`, `permissiveCombos`, `duplicatesCollapsed`, per-reason
  `exclusions`, `includedCrossGame`, and a per-combo `kept`/`dropReason` audit (`--no-audit` omits
  it).
- Three gates, layered:
  - `permissive` (default) — any combo touching a CFB game.
  - `--all-legs-cfb` — every leg is CFB and every leg's `market_sport_type` is
    `moneyline|spreads|totals`. **Cross-game is allowed.**
  - `--strict-full-game` — `all-legs-cfb` **and** single game.
- `eligible` means exactly `market_sport_type ∈ {moneyline, spreads, totals}`
  (`ELIGIBLE_LEG_TYPES`), the same predicate in both gated modes.
- Exclusions are **mode-relative and precedence-ordered**: `UNRESOLVED_LEGS` → `CROSS_GAME` (only
  when the gate is `full-game`) → `INELIGIBLE_LEG_TYPE`. Under `all-legs-cfb`, cross-game combos are
  counted in `includedCrossGame`, never in `CROSS_GAME`. Because of precedence, a bucket count is
  not comparable across gates — a cross-game combo with an ineligible leg is `CROSS_GAME` under
  `full-game` and `INELIGIBLE_LEG_TYPE` under `all-legs-cfb`.
- If `UNRESOLVED_LEGS > 0`, the gated count is a **floor**, not a point estimate — unresolved legs
  correlate with low-volume or delisted markets, so the exclusion is not random.
- Dedupe diagnostics: `duplicatesCollapsedById` and `duplicatesCollapsedByLegSet` are reported
  separately. A non-zero leg-set count proves the cross-indexer pass is doing work;
  `diagnostics.legsWithoutSide` shows whether any source lacks a side (which would make that pass
  inert against a sided source).

### Unresolved legs and index scope

`diagnostics.unresolved` counts combos that resolved **at least one** leg but not all:
`combos`, `legs`, `distinctLegKeys`, `oneOffLegKeys` vs `systemicLegKeys`, and the top keys.
`diagnostics.combosWithoutAttribution` counts combos that touched **zero** indexed games.

The first version of this report indexed only `active=true&closed=false` and took a top-100 slice.
That was a **resolver-scope bug**, not a long tail. Classifying the systemic keys through CLOB
(`/markets/{conditionId}` — Gamma's `condition_ids`/`condition_id` filters do not filter) showed 7
of the top 13 were real CFB/NBA markets that had simply **closed**.

The index now:

- includes closed games by default (a settled combo is still a unique combo event),
- paginates the whole `series_id=12756` (1,719 events) instead of a top-100 slice,
- supports `--open-only` and `--since YYYY-MM-DD`.

Effect on the same 322-wallet set:

| Index                           | permissive | all-legs-cfb | full-game |
| :------------------------------ | ---------: | -----------: | --------: |
| open-only, top 100              |         80 |           32 |         0 |
| active+closed, top 100          |        201 |           72 |         0 |
| **active+closed, whole series** |    **485** |      **308** |    **26** |

The earlier product claim — "single-game CFB combos are not a style this book uses" — is **retired**.
It was an artifact of the open-only, top-100 window. With the whole season indexed, 26 single-game
all-CFB eligible combos exist; they were simply settled games outside the slice.

Current diagnostics (whole series, 322 wallets):

```
partial unresolved: 174 combos, 383 legs, 267 distinct (214 one-off / 53 systemic)
combos without attribution: 15,809 (mostly non-CFB: LoL, politics, crypto)
zero-padded / combo-of-combo keys: 134 distinct (404 on CLOB)
cfbTouchRatePct: 2.98% of observed combos
```

`diagnostics.cfbTouchRatePct` is a **seeder-mix** metric, not resolver quality: non-CFB combos sit
in the denominator. A leaderboard-seeded set will always look low; trade-seeded wallets are the
high-yield ones.

Seeder mix on the same index (2 combo pages per wallet):

| Seeder                                        | Wallets | Permissive combos | CFB touch | Combos / wallet |
| :-------------------------------------------- | ------: | ----------------: | --------: | --------------: |
| `--seed-trades --no-leaderboard` (20 markets) |      95 |               356 |     5.51% |            3.75 |
| leaderboard only (100 rows × 3 periods)       |     233 |               129 |     1.30% |            0.55 |

Trades seeding is ~6.8× more efficient per wallet and ~4.2× higher touch rate. The leaderboard
path is a supplement, not the primary discovery route: it costs ~2.5× the wallet fetches for ~27% of
the CFB combos. Use `--seed-trades --no-leaderboard` when API budget matters.

### Live result (2026-10-31)

With 322 seeded wallets, whole-series index, 3 combo pages per wallet:

| Gate           |    Kept | Exclusions                                   |
| :------------- | ------: | :------------------------------------------- |
| `permissive`   |     485 | — (317 span >1 game)                         |
| `all-legs-cfb` | **308** | 174 partial-unresolved, 3 ineligible         |
| `full-game`    |  **26** | 174 unresolved, 284 cross-game, 1 ineligible |

```
verify-subset --chain :
  all-legs-cfb ⊆ permissive   reference 485, treatment 308, leaks 0
  full-game    ⊆ all-legs-cfb reference 308, treatment  26, leaks 0
  exit 0
```

The chain is now **non-vacuous**: every edge has a non-empty treatment set, and the definition
`full-game = all-legs-cfb ∧ single-game` is asserted rather than inferred. Cross-indexer dedupe
collapsed 277 duplicates by leg-set and 1 by id on this run.

Exit codes: `1` = leak always; `2` = vacuous **only** with `--strict-exit`. Default vacuous is a
warning plus exit 0, so a structurally-zero gate does not fail unattended runs.

- Cache: `scratch/cfb-combo-cache/<wallet>.json`, TTL 24h by default; corrupted files are refetched.

## 5. Backtesting (realized PnL)

`dx combo backtest` measures what the combos actually did, from public activity:

```bash
./bin/dx combo backtest --wallets 0x26cf…c612 --days 30
./bin/dx combo backtest --wallet-file wallets.txt --days 7 --json
./bin/dx combo backtest --all-venues --days 30          # skip CFB attribution
```

Method:

- cost = `SPLIT` / `TRADE` / `BUY` `amount_usdc`; payout = `REDEEM` `payout_usdc` plus
  `MERGE` / `SELL` `amount_usdc`.
- Combos are grouped by `combo_condition_id|wallet`; open combos are reported separately and are
  **excluded** from realized cost/payout/PnL.
- Win rate = settled combos with `pnl > 0`. Market-maker / split-arbitrage combos can settle at
  roughly zero, so a very low win rate with a small positive ROI is expected.
- Cross-game share is only defined when the CFB game index is loaded (default); `--all-venues`
  reports it as `null`.
- Per-day and per-game tables; `--json` returns every trade.

First live run (single wallet, 7 days, all venues):

```
1,424 combos (743 settled / 681 open) | cost $387,213.54 | payout $390,417.06
PnL +$3,203.52 | ROI 0.8% | win 0.4% | avg legs 3.42
```

Pricing calibration is a separate pass: `clob.polymarket.com/prices-history?market=<token>&startTs=&endTs=&fidelity=`
is live-verified and can compare the product-of-legs fair price at the combo entry timestamp with the
actual entry price. That requires mapping each leg to its CLOB token id; it is not part of the
realized-PnL backtest yet.

## 6. Coverage limits

- Wallets that only trade combos and never appear in sampled CFB trades or the PnL leaderboard are
  not discoverable publicly. `--wallet-file` is the escape hatch.
- `--seed-trades` samples up to `--max-seed-markets` condition IDs (60 by default); raising it
  increases coverage and request volume.
- Activity/positions pagination is cursor-based; the CLI caps pages (`--max-combo-pages`).
