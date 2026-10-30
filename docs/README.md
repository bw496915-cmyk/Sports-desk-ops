# SportsDesk ops docs

| Doc | Audience | Contents |
|-----|----------|----------|
| [schema-dump-operations.md](./schema-dump-operations.md) | Registry + release | `dump-prod` vs `sync-prod-dump`, snapshot parity, allowlist, `captured_at` / dump lag |
| [schema-sqlite-failure-mode-matrix.md](./schema-sqlite-failure-mode-matrix.md) | Debug parity exits | Exit **2** / **3**, env knobs, SQLite strict/sentinel, EOD WAL |

**CLI entry:** `bun run sportsdesk_schema_cli.ts --help`

**CI:** `bun run schema:gate` (typecheck slice + snapshot parity with `CI=true`).
