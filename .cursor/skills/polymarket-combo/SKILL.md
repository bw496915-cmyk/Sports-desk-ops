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
./bin/dx combo uniqueness --all-legs-cfb              # CFB-only, cross-game allowed
./bin/dx combo verify-subset [--all-legs-cfb] --wallet-file scratch/seed.txt
./bin/dx combo backtest --wallets 0x26cf…c612 --days 30 [--all-venues]
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
6. Three gates, each a **pure filter after attribution** (so stricter ⊆ looser):
   - default `permissive` — any combo touching a CFB game;
   - `--all-legs-cfb` — every leg is CFB and every leg's `market_sport_type` is
     `moneyline|spreads|totals`; **cross-game allowed**;
   - `--strict-full-game` — `all-legs-cfb` **and** single game.
   Exclusions are mode-relative and precedence-ordered (`UNRESOLVED_LEGS` → `CROSS_GAME` under
   full-game only → `INELIGIBLE_LEG_TYPE`); cross-game combos admitted by `--all-legs-cfb` appear
   as `includedCrossGame`, never as a drop. Bucket counts are not comparable across gates.
   `--json` reports `gate`, `permissiveCombos`, `duplicatesCollapsed*`, `exclusions`,
   `includedCrossGame` and a per-combo `kept`/`dropReason` audit (`--no-audit` omits it).
7. `verify-subset --chain` asserts both edges — `full-game ⊆ all-legs-cfb ⊆ permissive` — not
   just permissive-vs-treatment. `--against <gate>` checks one edge; a gated reference compares on
   its **kept** set. Exit 1 = leak; exit 2 = vacuous only with `--strict-exit` (default warns and
   exits 0, so a structurally-zero gate does not fail unattended runs). A `0` treatment proves
   nothing.
8. Dedupe twice: `comboId|wallet`, then `legSignatures|wallet` (`legKey|outcome|marketType`) to
   collapse cross-indexer duplicates without merging distinct same-condition markets.
   `UNRESOLVED_LEGS > 0` means the gated count is a floor.
9. Verify, don't inspect: `--dump-wallets` then `--emit-ids` in both modes, and
   `comm -23 <(sort strict) <(sort any)` must print nothing. Empty sets write empty files.
   Check `diagnostics.legsWithoutSide` and `duplicatesCollapsedByLegSet`: if sides are empty the
   cross-indexer pass is inert; if leg-set collapses are zero it may be doing nothing.
10. Cache: `scratch/cfb-combo-cache/<wallet>.json`, TTL 24h (`--cache-ttl-hours`), `--fresh` bypasses.
11. Env aliases: `CACHE_TTL_HOURS`, `CACHE_DIR`, `FRESH=1`, `STRICT_FULL_GAME=1`, `ALL_LEGS_CFB=1`, `SEED_TRADES=1`,
   `CONCURRENCY`, `LEADERBOARD=0`, `LEADERBOARD_LIMIT`, `MAX_SEED_MARKETS`, `WALLET_FILE`.
   CLI flags win over env.
12. `lb-api.polymarket.com` is retired (410); use `data-api/v2/leaderboard`.

## Backtest

`dx combo backtest` groups activity by `combo_condition_id|wallet`: cost from SPLIT/TRADE/BUY,
payout from REDEEM/MERGE/SELL. Open combos are excluded from realized totals; win rate is
`pnl > 0`. `--all-venues` skips CFB attribution and reports cross-game as null. It measures realized
outcomes, not a simulated strategy; price-history calibration is separate.

## Limits

- Wallets that only trade combos and never appear in sampled trades or the leaderboard are
  undiscoverable publicly; `--wallet-file` is the escape hatch.
- Per-game counts double-count cross-game combos by design; compare `sumPerGameCombos` with
  `distinctCombos`.
