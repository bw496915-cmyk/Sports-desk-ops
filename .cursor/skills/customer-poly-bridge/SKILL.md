---
name: customer-poly-bridge
description: >-
  Join the SportsDesk customer book to Polymarket wallets with `dx bridge`: attribution health,
  fee-aware cross-venue PnL, and leg-level mirror/opposite matching. Read-only, no key.
---

# Customer ↔ Polymarket bridge

Answers: **do our customers show value on Polymarket, and where?**

Implementation: `lib/customer_poly_bridge.ts` + `scripts/customer_bridge_cli.ts`.
Do not shell out to curl; do not add npm packages.

## Commands

```bash
./bin/dx bridge coverage                       # link yield, attribution types, quarantine
./bin/dx bridge value --live --top 15          # cross-venue PnL (live Polymarket profiles)
./bin/dx bridge value --customer BGD101 --json # one customer, auditable rows
./bin/dx bridge match --seed --db scratch/cross-domain.sqlite
./bin/dx bridge match --customer GP300 --max-delta 50 --json
```

## The three joins

1. **Attribution** — `customerId ↔ 0x wallet`. Union of the engine's map (unverified, 50%) and the
   typed IP/CTF clusters (up to 100%). Wallets must be 42-char hex; placeholders are quarantined,
   never queried.
2. **Value** — `customerDeskPnlUsd = -lifetime_net_usd` vs the wallet's Polymarket PnL.
   `polyAdvantageUsd = polyPnl - customerDeskPnl`.
3. **Legs** — `combo_observations_legs` self-join on game/period/subject/market through the
   attribution table. `MIRROR` (same side), `OPPOSITE` (hedge shape), line delta in hundredths.

## Rules that matter

1. **Gross is not net.** Polymarket's own PnL is pre-fee. Use the `NET` basis only when activity
   pagination completed; otherwise the row says `GROSS`. Never present a partial cashflow replay
   as final.
2. **Dedupe by wallet.** A wallet can be attributed to two customers (4 such wallets today). Sum
   Polymarket PnL over unique wallets and exclude shared-wallet rows from advantage totals.
3. **`POLY_ONLY_UP` is a lead, not proof.** It only says the customer did better on Polymarket than
   at the desk. A hedge needs leg-level `OPPOSITE` matching on the same market with time alignment.
4. **`OPPOSITE` is a shape.** The same customer can hold independent views; do not call it a hedge
   without the ticket timestamps.
5. **Null is not zero.** Unranked wallets return `data: null`. Report "no PnL figure" and keep them
   out of verdict counts.
6. **Quarantine beats guessing.** A 35-char wallet is a placeholder; never pad it to 42 chars.
7. **Evidence tier is mandatory** in any summary: `LIVE`, `MIXED`, or `FIXTURE`.

## Output

Text summary by default or `--json` for the full report (`coverage`, `value`, per-customer rows,
quarantine list). Money is USD; wallets are lowercased.

## Evidence limits

- The bundled book is a 220-row sample, not the 9,435-account downline.
- 19 of 220 sampled customers are linked; attribution is the binding constraint.
- Active wallets exceed the activity cap, so NET coverage is often a single-digit percentage.
- Leg matching requires structured legs; free-text `recent_tickets` selections are not matched.
