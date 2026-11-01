# Customer ↔ Polymarket cross-domain bridge

Answers one question: **does our customer book show value on Polymarket, and where?**

Read-only. Public APIs only. `dx bridge` joins three layers, in increasing strength of evidence:

| Layer       | Join                                     | Source                                                            | What it can prove                                              |
| :---------- | :--------------------------------------- | :---------------------------------------------------------------- | :------------------------------------------------------------- |
| Attribution | `customerId ↔ 0x wallet`                 | `lib/parlay_combo_backtest_engine.ts` map + typed IP/CTF clusters | That a link exists, and how strong it is                       |
| Value       | customer desk P/L ↔ wallet P/L           | `enriched_customers_full.json` + Polymarket profile               | Whether outcomes diverge, observationally                      |
| Leg         | F402 ticket legs ↔ Polymarket combo legs | `combo_observations_legs` SQLite store                            | Whether the same market is played, on which side, at what line |

## 0. Claim basis

| Claim                                                   | Label                                                                                        |
| :------------------------------------------------------ | :------------------------------------------------------------------------------------------- |
| Gate math, dedupe, PnL arithmetic                       | `[CODE]` — tests in `tests/combo_uniqueness.test.ts`, `tests/customer_poly_bridge.test.ts`   |
| `lb-api.polymarket.com` returns HTTP 410                | `[OBSERVED]` 2026-10-31                                                                      |
| `v2/leaderboard?user=&time_period=` windows             | `[OBSERVED]` 2026-10-31                                                                      |
| Provider PnL is pre-fee; the activity residual is a fee | `[UNVERIFIED]` — inferred from a third-party toolkit plus the residual; check before quoting |
| Customer↔wallet attributions                            | `[UNVERIFIED]` — static map, 50–100% confidence                                              |
| `lifetime_net_usd` is the desk's net                    | `[ASSUMPTION]` — sign convention in the fixture; verify against F402                         |

## 1. Commands

```bash
# Attribution health: link yield, attribution types, quarantined placeholders
./bin/dx bridge coverage
./bin/dx bridge coverage --json

# Cross-venue PnL (offline: book + static attributions only)
./bin/dx bridge value --top 15

# Cross-venue PnL with live Polymarket profiles
./bin/dx bridge value --live --customer BGD101 --customer MJ102
./bin/dx bridge value --live --fresh --json > scratch/bridge-live-all.json

# Leg-level matching over the observation store (seeds the demo scenario if empty)
./bin/dx bridge match --db scratch/cross-domain.sqlite
./bin/dx bridge match --reset --db scratch/cross-domain.sqlite      # rebuild the demo store
./bin/dx bridge match --customer GP300 --max-delta 50 --json
```

`--seed` is a no-op on a populated store; `--reset` clears it first. Matching never mutates
anything on its own.

Common flags: `--book`, `--customer`, `--top`, `--live`, `--fresh`, `--cache-dir`,
`--concurrency`, `--db`, `--seed`, `--max-delta`, `--json`.

## 2. Attribution and quarantine

The registry is the union of the engine's 34-entry customer→wallet map and the typed
attributions from the layoff-risk scenario. Typed entries win on conflict; untyped map entries are
`WALLET_MAP_UNVERIFIED` at 50% confidence.

Wallets must be 42-char `0x` hex. Anything else is **quarantined** with a reason
(`BAD_LENGTH`, `BAD_PREFIX`, `NON_HEX`, `EMPTY`) and never queried — the map contains 10
placeholder wallets of 20–35 characters that would otherwise produce misleading 404s.

`coverage` also reports:

- **multi-wallet customers** — one customer linked to more than one wallet.
- **shared wallets** — one wallet linked to more than one customer. A shared wallet is either a
  duplicate customer record or a real syndicate; it must be resolved before the PnL is read as
  per-customer.

## 3. Value math

```
customerDeskPnlUsd = -lifetime_net_usd      # [ASSUMPTION] the book stores the desk's net
deskHoldPct        = lifetime_net_usd / lifetime_volume_usd × 100   # desk perspective
polyAdvantageUsd   = polyBasisPnlUsd - customerDeskPnlUsd
priorityUsd        = max(0, polyAdvantageUsd) × confidenceBps / 10 000
```

`polyBasisPnlUsd` is **NET** when the activity replay completed, otherwise **GROSS**. The basis is
reported per row so a reader never has to guess which number they are looking at.

Aggregate rules:

- Polymarket totals are summed over **unique wallets**, so a wallet attributed to two customers is
  counted once.
- Rows on a **shared wallet** are excluded from `polyAdvantageUsd` and `priorityUsd` (they remain
  visible per row) because the same Polymarket result must not be booked against two books.
- `polyAdvantageUsd` is the **signed** sum; `priorityUsd` sums only positive advantages, weighted
  by link confidence. It is a review queue, not revenue.

Verdicts are from the **customer's** perspective:

| Verdict        | Meaning                                                                   |
| :------------- | :------------------------------------------------------------------------ |
| `BOTH_UP`      | Customer wins at the desk and on Polymarket                               |
| `POLY_ONLY_UP` | Customer wins on Polymarket, loses at the desk — the lead worth reviewing |
| `DESK_ONLY_UP` | Customer loses on Polymarket, wins at the desk                            |
| `BOTH_DOWN`    | Customer loses on both                                                    |
| `FLAT`         | Within ±$1 on one side                                                    |

`POLY_ONLY_UP` is a **lead, not proof**. Proving a hedge or a layoff needs the leg-level layer,
because a customer can independently hold a directional view on each venue.

`priorityUsd` exists only to order the review queue. It is not revenue, and it is not a
probability-weighted forecast.

## 4. Fee-aware PnL (why the official number is not the answer)

`lb-api.polymarket.com` is **retired** (HTTP 410). The profiler now reads
`data-api.polymarket.com/v2/leaderboard?user=<0x>&time_period=all|month|week`:

- `all` → lifetime, `month` → 30d, `week` → 7d
- omitting `time_period` behaves like `day`; it is never used

A third-party toolkit reports that Polymarket's own PnL is **pre-fee** (`[UNVERIFIED]` here — we
have not confirmed it against a fee-bearing capture). `auditActivityPnl` replays the activity log:

```
cashflowPnl = (SELL + REDEEM + MERGE + REBATE) − (BUY + SPLIT) + open position value
feeResidual = Σ |usdcSize − size × price|              (TRADE rows only)
gap         = cashflowPnl − lbApiPnl
```

Two honesty rules:

- If pagination was truncated (`pages >= maxActivityPages`), `cashflowPnl` is **null**, not a
  partial number that looks authoritative. The reason string says `ACTIVITY_TRUNCATED`.
- `feeResidual` is a **lower bound** on taker fees. Zero means maker _or_ fee-exempt, never
  "no fees".

Active wallets commonly exceed the activity cap (one bridge wallet has 13k+ TRADE rows across 40
pages and still truncates), so GROSS is the normal basis for whales. That is disclosed in the
output rather than silently substituted.

## 5. Leg-level matching

`bridge match` joins `combo_observations_legs` to itself and requires a registered attribution:

```sql
pm.game_id = f402.game_id
AND pm.period = f402.period
AND pm.subject = f402.subject
AND pm.market_kind = f402.market_kind
AND LOWER(attr.proxy_wallet) = LOWER(pm.wallet_or_account)
AND UPPER(attr.customer_id)  = UPPER(f402.wallet_or_account)
```

Unlike `LayoffRiskEngine.queryLineDeltaMatches`, it **keeps opposite-side pairs**:

- `MIRROR` — same side at both venues.
- `OPPOSITE` — same game/market, other side. A hedge **shape**; not proof of intent.
- `lineDeltaHundredths` — integer canonical units (`combo_identity.ts`).
- `layoffRiskLegs` — Polymarket got the better of the two lines (`evaluateBetterVenue`).

`--max-delta` bounds the line window (default 100 hundredths = ±1.0 point).

### Fixed side classification

`mapPolyLeg` matched `"UNDERDOG".includes("UNDER")` before the exact `UNDERDOG` branch, so every
underdog spread became a total `UNDER`. Exact tokens are now checked first. This was silently
breaking side matching and `evaluateBetterVenue` for all underdog spreads.

## 6. Evidence tiers

| Tier      | Meaning                                                            |
| :-------- | :----------------------------------------------------------------- |
| `LIVE`    | Every linked wallet was observed live                              |
| `MIXED`   | Some linked wallets were observed, some were not                   |
| `FIXTURE` | Nothing was fetched; the bundled book and static attributions only |

The tier is printed at the top of `value` output so a fixture run is never mistaken for live data.

## 7. First live run (2026-10-31)

```bash
./bin/dx bridge value --live --concurrency 6
```

| Metric                                        | Value                          |
| :-------------------------------------------- | :----------------------------- |
| Customers in book                             | 220 (fixture sample)           |
| Customers linked to a wallet                  | 19 (8.6%)                      |
| Valid wallets                                 | 22                             |
| Quarantined placeholders                      | 10                             |
| Shared wallets (2 customers each)             | 4                              |
| Wallets with a PnL figure                     | 15 of 22                       |
| Customers with a PnL figure                   | 8 of 19                        |
| Desk volume (linked rows)                     | $5,295,104                     |
| Customer desk P/L                             | −$1,213,830 (desk hold −22.9%) |
| Polymarket gross P/L (unique wallets)         | +$513,389                      |
| Polymarket net P/L (1 of 15 wallets replayed) | −$9,763                        |
| Fee residual (replayed subset)                | $110,637 lower bound           |
| Signed poly advantage (unambiguous rows)      | +$277,988                      |
| Review priority                               | $675,143                       |

Verdicts over the 8 rows with PnL: `POLY_ONLY_UP` 5, `BOTH_DOWN` 3, `BOTH_UP` 0, `DESK_ONLY_UP` 0.

Top leads (customer won on Polymarket, lost at the desk, lifetime-to-lifetime):

| Customer                        |  Desk P/L | Polymarket gross |
| :------------------------------ | --------: | ---------------: |
| BGD101 / BB5127 (shared wallet) | −$137,400 |        +$685,666 |
| GP300                           |  −$33,858 |        +$339,843 |
| DN2019                          |  −$78,000 |         +$78,321 |
| DAN245                          |  −$42,000 |         +$68,515 |

Reading it honestly:

- The book sample is **mostly losing at the desk** (customers −$1.2M, desk +$1.2M) and **up on
  Polymarket gross** (+$513k). That is the value hypothesis: the same people do better on the
  prediction market than on our book.
- It is not proof. Gross is pre-fee, 11 of 22 wallets have no leaderboard PnL, and only one wallet
  replayed to completion. Net and fee numbers are lower bounds on the available subset.
- Four shared wallets (8 rows) are excluded from the advantage total; BGD101 and BB5127 are the
  same `0x26cf…c612`, so they are one economic actor, not two.
- `BOTH_UP` is zero, but that is a sample artifact: 11 linked customers have no PnL figure at all.

## 8. Limits

- Attribution is the bottleneck. 19 of 220 sampled customers are linked; 201 book rows have no
  wallet. Better attribution raises coverage more than any model does.
- The customer book is a 220-row fixture, not the full 9,435-account downline.
- The book is **internally inconsistent**: 338/1,100 tickets have `result` contradicting the sign of
  `net_usd`, `hold_pct` matches `net/volume` on 0/220 rows (sentinels like `-100`), and 48 wager
  numbers repeat across customers. Run `bun run scripts/audit_customer_book.ts` before quoting any
  channel or hold figure; treat those as fixture properties, not customer behavior.
- Shared wallets collapse two customers onto one wallet's PnL; resolve before per-customer use.
- `POLY_ONLY_UP` is observational. Only leg-level matching on the same market, with time
  alignment, can distinguish a hedge from two independent views.
- Leg matching requires structured legs (`sportType`, `team`, `line`, `shortDesc`). Free-text
  `recent_tickets` selections in the book are not matched.
- Activity pagination truncates for high-frequency wallets; NET basis is withheld instead of
  guessed.
