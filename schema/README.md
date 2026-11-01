# SQLite schema tooling

| Path | Role |
| ---- | ---- |
| `migrations/` | SQL migration stubs (`.gitkeep` until first migration lands) |
| `manifest.bin` | Local binary manifest written by `bun run schema --write-manifest` (gitignored) |
| `preload/schema-inspect.ts` | Preload for `bun run schema:inspect` / `schema:repl` |

Registry reports also write under `reports/schema.manifest.bin` during snapshot runs.
