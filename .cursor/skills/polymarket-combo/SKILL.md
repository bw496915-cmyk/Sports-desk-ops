---
name: polymarket-combo
description: >-
  Discover and price Polymarket CFB combos with the repo's Bun CLI: series 12756 legs,
  product-of-legs pricing, wallet combo positions/activity, and per-game uniqueness.
---

# Polymarket CFB combos

Public APIs only; no key. Implementation: `lib/polymarket_combo.ts`,
`lib/combo_uniqueness.ts`, `scripts/polymarket_combo_cli.ts`.

## Commands

```bash
./bin/dx combo legs --limit 10                 # upcoming CFB ML/spread/total legs
./bin/dx combo price --prices 0.38,0.80 --stake 10 --quoted 0.32
./bin/dx combo price --legs "cfb-fl-ga-2026-10-31=Georgia,cfb-nd-navy-2026-10-31=Notre Dame"
./bin/dx combo wallet 0x26cf…c612              # positions + activity
./bin/dx combo uniqueness --seed-trades --max-seed-markets 20 --strict-full-game
```

## Rules

1. **Discovery is user-anchored.** There is no global CFB combo feed. Seed wallets from
   `/trades?market=<conditionId>` and/or `/v2/leaderboard?time_period=week|month|all&sort_by=PNL`,
   then query `/v2/positions/combos?user=` and `/v2/activity/combos?user=`.
2. **Fair price = product of leg probabilities** (decimal). It assumes independent legs; same-game
   legs are correlated and the product is not a true price. Leg prices include vig.
3. `stake / fairPrice` = shares/payout on a binary share (1 share pays $1).
4. `makerMarginPct = (quoted/fair − 1) × 100`.
5. Attribution order: `leg_condition_id`/`conditionId` (incl. `market.condition_id`) → `market.slug`
   → CLOB token id. The v2 combo payload nests the market under `legs[].market`.
6. `--strict-full-game` keeps only single-game combos where every leg is CFB and every CFB leg is
   `moneyline|spreads|totals`.
7. Cache: `scratch/cfb-combo-cache/<wallet>.json`, TTL 24h (`--cache-ttl-hours`), `--fresh` bypasses.
8. `lb-api.polymarket.com` is retired (410); use `data-api/v2/leaderboard`.

## Limits

- Wallets that only trade combos and never appear in sampled trades or the leaderboard are
  undiscoverable publicly; `--wallet-file` is the escape hatch.
- Per-game counts double-count cross-game combos by design; compare `sumPerGameCombos` with
  `distinctCombos`.
