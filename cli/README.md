# CLI entrypoints

Bun CLIs invoked via `package.json` scripts or `bun run cli/<name>.ts`.

| Script | File |
| ------ | ---- |
| `bun run cli` | `sportsdesk_cli.ts` — primary surveillance / wire / R2 / replay surface |
| `bun run schema` | `sportsdesk_schema_cli.ts` |
| `bun run replay` | `sportsdesk_replay_cli.ts` |
| `bun run catalog` | `sportsdesk_catalog_cli.ts` |
| `bun run candidate` | `sportsdesk_candidate_cli.ts` |
| `bun run settlement` | `sportsdesk_settlement_cli.ts` |
| `bun run combo` | `sportsdesk_combo_cli.ts` |
| Layoff risk | `sportsdesk_layoff_risk_cli.ts` |

Shared libraries live under `../lib/`; long-running daemons under `../services/`.
