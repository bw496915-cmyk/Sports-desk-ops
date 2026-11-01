# Repository layout (root)

The root keeps **SSOT config**, **workspace metadata**, and **operator shortcuts**. Executable code lives in subdirectories.

| Path | Purpose |
| ---- | ------- |
| `cli/` | All `sportsdesk_*_cli.ts` entrypoints ([cli/README.md](cli/README.md)) |
| `services/` | Daemon, bot, R2, churn engine, ingestion ([services/README.md](services/README.md)) |
| `catalog/` | Fantasy402 sport navigation catalog ([catalog/README.md](catalog/README.md)) |
| `lib/` | Shared modules, F402 probes, schema, capture |
| `scripts/` | Generators, capture tooling, audits; deploy scripts in `scripts/deploy/` |
| `static/` | Token-compiled daemon HTML dashboards |
| `docs/` | Evidence-labelled API docs, operator runbooks under `docs/runbooks/` |
| `tests/` | Bun test suites |
| `bin/dx` | Primary operator wrapper (status, deploy, modes, backtest) |
| `domain-branded-types.ts` | Generated branded types (`bun run gen:tokens`) |
| `tokens.toml` | Design token SSOT |
| `package.json` | Scripts map to `cli/` and `services/` paths |

**Deploy & reports**

- `bun run deploy` → `scripts/deploy/deploy_to_vps.sh`
- `bun run reports` → `scripts/deploy/run_reports.sh`
- `bun run deploy:docs` → `scripts/deploy/deploy_docs.sh`
