# Polymarket CFB combos — discovery, pricing and uniqueness

Operator and engineering notes for CFB combo work. Public APIs only; no key.

## 1. What is verified

| Surface | Endpoint | Evidence |
| :--- | :--- | :--- |
| CFB events / legs | `GET gamma-api.polymarket.com/events?series_id=12756&active=true&closed=false&order=volume24hr&ascending=false&limit=50` | Live 2026-10-31: 50 events, ML/spread/total markets with `outcomes`/`outcomePrices` JSON strings |
| Combo positions | `GET data-api.polymarket.com/v2/positions/combos?user=<0x>` | Live 2026-10-31: `{data, pagination}`, nested `legs[].market` |
| Combo activity | `GET data-api.polymarket.com/v2/activity/combos?user=<0x>` | Live 2026-10-31: `{data, pagination}` |
| Wallet seed (trades) | `GET data-api.polymarket.com/trades?market=<conditionId>&limit=100` | Live 2026-10-31: array with `proxyWallet` |
| Wallet seed (leaderboard) | `GET data-api.polymarket.com/v2/leaderboard?time_period=week|month|all&sort_by=PNL&limit=100` | Live 2026-10-31: `{data:[{user_id,...}], pagination}` |

`lb-api.polymarket.com` is **retired** (HTTP 410). Do not use it.

There is **no global CFB combo feed**. Discovery is user-anchored: seed wallets, then query their
combo endpoints.

## 2. Product-of-legs pricing

For independent legs (different games):

```
fairPrice = p1 × p2 × … × pn          (decimal probabilities, 0–1)
shares    = stake / fairPrice
payout    = shares × $1                (binary share)
```

| Example | Fair price | $10 payout | Multiple |
| :--- | :--- | :--- | :--- |
| 2-leg 38¢ + 80¢ | 30.4¢ | $32.89 | 3.29× |
| 3-leg 60¢ + 55¢ + 50¢ | 16.5¢ | $60.61 | 6.06× |

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

# per-game unique combos and wallets
./bin/dx combo uniqueness --seed-trades --max-seed-markets 20 --limit-games 20
./bin/dx combo uniqueness --strict-full-game --json
```

`uniqueness` options: `--fresh` (ignore cache), `--cache-dir`, `--cache-ttl-hours` (default 24),
`--no-leaderboard`, `--leaderboard-limit`, `--seed-trades`, `--max-seed-markets`, `--wallet-file`,
`--strict-full-game`, `--limit-games`, `--max-combo-pages`.

### Environment knobs

CLI flags win over environment, which wins over defaults.

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `CACHE_TTL_HOURS` | `24` | Cache age before a wallet is refetched; `0` disables reuse |
| `CACHE_DIR` | `scratch/cfb-combo-cache` | Cache location |
| `FRESH` | unset | `1` ignores the cache for this run |
| `STRICT_FULL_GAME` | unset | `1` enables single-game ML/spread/total-only counts |
| `SEED_TRADES` | unset | `1` seeds wallets from sampled CFB trades |
| `CONCURRENCY` | `6` | Wallet fetch parallelism |
| `LEADERBOARD` | enabled | `0` skips leaderboard seeding |
| `LEADERBOARD_LIMIT` | `100` | Rows per leaderboard period |
| `MAX_SEED_MARKETS` | `60` | Condition IDs sampled by the trade seeder |
| `WALLET_FILE` | unset | Extra wallet addresses (whitespace-separated) |

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
  modes. `--json` exposes `permissiveCombos`, `duplicatesCollapsed`, per-reason
  `strictExclusions`, and a per-combo `kept`/`dropReason` audit trail (`--no-audit` omits it).
- Strict drop reasons, in precedence order: `UNRESOLVED_LEGS` (a leg could not be attributed to
  any CFB game), `CROSS_GAME`, `INELIGIBLE_LEG_TYPE`. If `UNRESOLVED_LEGS > 0`, the strict count
  is a **floor**, not a point estimate — unresolved legs correlate with low-volume or delisted
  markets, so the exclusion is not random.
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
