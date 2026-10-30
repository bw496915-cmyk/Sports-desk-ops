# SportsDesk ops docs

| Doc                                                                            | Audience           | Contents                                                                              |
| ------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------- |
| [api-reference.md](./api-reference.md)                                         | Developers & Risk  | Official wire API reference, getWebLog HAR contract, PaddedCustomerId rules, vig tax  |
| [openapi.json](./openapi.json)                                                 | API / OpenAPI 3.1  | Authoritative OpenAPI 3.1 machine-readable wire specification                         |
| [index.html](./index.html)                                                     | Interactive Portal | Single-page Redoc interactive API documentation viewer with dark theme                 |
| [schema-dump-operations.md](./schema-dump-operations.md)                       | Registry + release | `dump-prod` vs `sync-prod-dump`, snapshot parity, allowlist, `captured_at` / dump lag |
| [schema-sqlite-failure-mode-matrix.md](./schema-sqlite-failure-mode-matrix.md) | Debug parity exits | Exit **2** / **3**, env knobs, SQLite strict/sentinel, EOD WAL                        |

**CLI entry:** `bun run sportsdesk_schema_cli.ts --help` · `bun sportsdesk_cli.ts forensics --help`

**CI:** `bun run schema:gate` — typecheck, snapshot parity (`CI=true`), fixture drift check, parity gauntlet, EOD smoke.

**Drills:** `schema:parity-gauntlet` · `schema:check-fixture-drift` · `eod:smoke`

**Diagram:** [assets/ARCH-Guide.png](./assets/ARCH-Guide.png)
