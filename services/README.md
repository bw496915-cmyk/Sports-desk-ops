# Long-running services & domain engines

| File | Role |
| ---- | ---- |
| `sportsdesk_webview_server.ts` | Bun HTTP daemon (`bun run serve`) — dashboards, graph, Telegram webhook |
| `sportsdesk_telegram_bot.ts` | Bot API, watch list, scheduled reports |
| `reporting_scheduler_service.ts` | Cron-style report dispatch |
| `sportsdesk_r2_sync.ts` | Cloudflare R2 SigV4 sync |
| `simulate_bettor_churn_suite.ts` | Churn simulation & consumer wire types (OpenAPI tier-C evidence) |
| `agent_onepass_plugin.ts` | Streaming liability accumulator |
| `sportsdesk_ingestion_*.ts` | Feed pull, provenance, JSONL replay |

Static HTML is served from `../static/`; repo root holds SSOT `domain-branded-types.ts` and `tokens.toml`.
