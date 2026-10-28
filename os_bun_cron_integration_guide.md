# SportsDesk & Fantasy402 OS Cron & Native Bun Cron Integration Guide

This guide details the integration of automated scheduled reporting and risk surveillance across **Linux OS Cron (`/etc/cron.d/sportsdesk-ops` / `crontab`)** and the **Native Bun Cron Scheduling Engine (`sportsdesk_cron_service.ts` / `sportsdesk_cli.ts cron`)**.

## 1. Operational Scheduling Cadences (America/New_York)

| Job ID                          | Cadence                | Cron Syntax  | Output Format | Target Action / Script                                  | Operational Objective                                                                      |
| :------------------------------ | :--------------------- | :----------- | :------------ | :------------------------------------------------------ | :----------------------------------------------------------------------------------------- |
| **`hourly_snipers`**            | Hourly (:00)           | `0 * * * *`  | JSON          | `sportsdesk_cli.ts winners -p 24h`                      | Intra-day sniper surveillance; flags sharp accounts hitting max limits on opening numbers. |
| **`morning_audit_bundle`**      | Daily 08:00 EDT        | `0 8 * * *`  | Table         | `./run_reports.sh --format table`                       | Morning briefing generating the complete 7-report auditable surveillance bundle.           |
| **`midday_steam_pulse`**        | Daily 13:00 EDT        | `0 13 * * *` | JSON          | `sportsdesk_cli.ts winners -p 7d --league NBA -m total` | Midday pulse detecting line moves, steam originations, and in-play velocity.               |
| **`evening_settlement_recap`**  | Daily 23:00 EDT        | `0 23 * * *` | Table         | `./run_reports.sh --format table`                       | Daily settlement figures, net house hold deficit/profit, and 50% agent liability balances. |
| **`weekly_settlement_rollup`**  | Monday 00:05 EDT       | `5 0 * * 1`  | CSV           | `./run_reports.sh --format csv`                         | Weekly 7-day settlement week rollup exported into timestamped CSV sheets.                  |
| **`monthly_leaderboard_sweep`** | 1st of month 00:10 EDT | `10 0 1 * *` | CSV           | `sportsdesk_cli.ts leaderboard -p month --limit 50`     | 30-day dual-sided leaderboard review and lifetime house hold pillar rankings.              |

## 2. Quick Commands

```bash
# Run all 7 reports immediately with table output
./run_reports.sh --format table

# Run and automatically upload to Cloudflare R2
./run_reports.sh --format table --sync-r2

# Run weekly CSV settlement export
./run_reports.sh --format csv
```
