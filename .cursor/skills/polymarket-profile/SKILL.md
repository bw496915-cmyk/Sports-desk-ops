---
name: polymarket-profile
description: >-
  Profile a Polymarket address with the repo's Bun CLI (`dx profile`): PnL, win rate, open
  positions, category mix, activity summary and strategy pattern from public APIs, no key.
---

# Polymarket address profile (SportsDesk adaptation)

Adapted from the public `runesleo/polymarket-toolkit` skill. The upstream skill used `curl`/`node`
and `lb-api`, which is now retired; this version uses the repo's Bun CLI and the v2 APIs.

## Trigger

A user gives a 0x address, a Polymarket profile URL, or a username and wants trading analysis.

## Command

```bash
./bin/dx profile 0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612
./bin/dx profile <username>            # resolved via v2 leaderboard cursor
./bin/dx profile 0x… --json            # full structured profile
./bin/dx profile 0x… --max-activity-pages 40 --timeout-ms 15000
```

Implementation: `lib/polymarket_profile.ts` + `scripts/polymarket_profile_cli.ts`.
Do not shell out to curl; do not add npm packages.

## APIs (public, no auth)

| Endpoint | Purpose |
| :--- | :--- |
| `data-api.polymarket.com/positions?user=<0x>&sizeThreshold=0&limit=500&offset=` | current positions |
| `data-api.polymarket.com/activity?user=<0x>&limit=500&end=<last timestamp>` | activity, cursor by timestamp |
| `data-api.polymarket.com/v2/leaderboard?window=all&limit=500&cursor=` | username → wallet (lb-api is retired) |
| `gamma-api.polymarket.com/events?slug=<eventSlug>` | category/tags |

## Rules that matter

1. **Username resolution** uses v2 leaderboard cursor pagination (`pagination.next_cursor`), max 3
   pages. If not found, ask for the 0x address; the account is likely unranked.
2. **Activity pagination uses `end=<last timestamp>`**, not offsets. Do not dedupe: repeated
   `transactionHash` rows can be separate fills.
3. **Activity `slug` is empty in v2.** Use `slug || eventSlug || conditionId` as the market key.
4. **Win rate** = won / (won + lost), where `redeemable == true` and `currentValue > 0` means won;
   `redeemable == true` and `currentValue == 0` means lost. Never use `cashPnl > 0` as the win test.
   If won+lost < 3, estimate from REDEEM vs TRADE activity and label it.
5. **PnL**: `lb-api` is retired (HTTP 410). Use the sum of position `cashPnl` and label it as such;
   a ranked address can also be looked up on the v2 leaderboard, but the endpoint has no address
   filter, so the CLI does not paginate the whole board for it.
6. **Categories**: Gamma `category` first, then tag labels, then title keywords. Old markets may
   return `[]`; fall back to title inference.
7. **Pattern classification** (SPLIT arbitrage, market maker, whale/concentrated, diversified,
   small trader, mixed) is internal; explain the result with the trader's numbers, not thresholds.
8. Rate limits are undocumented: keep concurrency ≤ 4 and sleep 500 ms between activity pages.

## Output

Text summary by default (PnL, win rate, open positions, category mix, activity, top wins/losses) or
`--json` for the full `AddressProfile`. All money is USD; addresses are lowercased.

## Evidence limits

- `cashPnl` is approximate for partially sold positions.
- Win rate from positions can be skewed for accounts whose settled positions were cleaned up; the
  activity fallback is labelled.
- Gamma may omit categories for settled markets; keyword inference is a heuristic.
