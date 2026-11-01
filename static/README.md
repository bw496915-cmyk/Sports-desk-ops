# Daemon static HTML

Token-compiled dashboards served by `sportsdesk_webview_server.ts`:

- `customer-churn-simulation-dashboard.html` — `GET /` and `GET /dashboard`
- `telegram-miniapp-dashboard.html` — `GET /miniapp`

Regenerate token slices: `bun run gen:tokens` (see `lib/gen_tokens/emission_targets.ts`).
