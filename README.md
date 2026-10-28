# SportsDesk & Fantasy402 Operations Suite

Production intelligence, downline risk surveillance, Cloudflare R2 backup, and automated reporting pipeline built on the **Bun runtime (v1.4+)** for SportsDesk and Fantasy402 books.

Repository: [bw496915-cmyk/Sports-desk-ops](https://github.com/bw496915-cmyk/Sports-desk-ops.git)

## Quick Start

```bash
cd /Users/nolarose/dotfiles/sportsdesk-ops

# 1. Inspect nominal branded types & domain invariants
bun run sportsdesk_cli.ts -b

# 2. Run 24h sniper surveillance
bun run sportsdesk_cli.ts winners -p 24h --limit 25

# 3. Generate all 7 auditable surveillance reports
./run_reports.sh --format table

# 4. Run 52-week bettor churn simulation
bun run simulate_bettor_churn_suite.ts
```

## GitHub Deployment

To initialize and push this suite to GitHub:

```bash
cd /Users/nolarose/dotfiles/sportsdesk-ops
git init -b main
git remote add origin https://github.com/bw496915-cmyk/Sports-desk-ops.git
git add .
git commit -m "feat(sportsdesk-ops): initial release of risk surveillance, churn suite, and R2 backup"
git push -u origin main
```

## Project Structure

- `sportsdesk_cli.ts` — Surveillance, leaderboards, forensics, and Cloudflare R2 integration CLI.
- `domain-branded-types.ts` — 16 nominal branded primitives enforcing strict financial and domain typing.
- `sportsdesk_r2_sync.ts` — Zero-dependency S3 SigV4 sync client for Cloudflare R2 object storage.
- `run_reports.sh` — 7-report auditable surveillance pipeline with optional `--sync-r2`.
- `deploy_to_vps.sh` — One-click automated installer for Systemd, Nginx, Let's Encrypt SSL, and Telegram webhooks.
- `sportsdesk_telegram_bot.ts` — Real-time wager alert dispatcher and interactive bot commands.
- `reporting_scheduler_service.ts` — 08:00, 13:00, 23:00 EDT scheduled reporting daemon.
- `agent_onepass_plugin.ts` — Single-pass streaming 50% liability portfolio accumulator.
- `simulate_bettor_churn_suite.ts` — 52-week dual-basis bettor churn simulation suite.
- `customer-churn-simulation-dashboard.html` — Interactive Webview and executive dashboard.
- `telegram-miniapp-dashboard.html` — Telegram Mini App (TMA) mobile dashboard.
- `cloudflare_r2_and_api_runbook.md` — Complete Cloudflare API & R2 credentials setup guide.
- `os_bun_cron_integration_guide.md` — OS crontab and Bun cron integration guide.
- `vps_domain_setup_runbook.md` — Production VPS domain deployment runbook.
