# Schema dump operations

Operational boundaries for the committed prod schema fixture (`tests/fixtures/prod-schema.json`), dump scripts, and manifest parity in `schema:snapshot` / `postschema`.

## Artifact

Versioned JSON (`format_version` **1**): `PRAGMA table_xinfo` column shape per user table, optional `allowlist`, `source` (reviewer label, not proof of origin), and `captured_at` (ISO-8601 observation time). No row data. Default dump path overridable with `SPORTSDESK_SCHEMA_DUMP`.

## `schema:dump-prod` vs `schema:sync-prod-dump`

| Command | Input | Updates `tables` from | `allowlist` | `captured_at` |
|---------|--------|------------------------|-------------|---------------|
| `schema:dump-prod` | Prod SQLite path or `SPORTSDESK_SCHEMA_DB` | Live file (`captureProdSchemaFromDb`, `source` e.g. `prod-readonly`) | Preserved from existing outfile if present | **Refreshed** to capture time |
| `schema:sync-prod-dump` (`--from-registry`) | TypeScript registry only (`buildRegistryBaselineProdDump`) | Registry report | Preserved from existing outfile | **Preserved** from existing outfile |

Use **dump-prod** after reading prod to refresh the fixture. Use **sync-prod-dump** when registry changed but you are not re-reading prod (CI-safe baseline); it must not pretend to be a prod capture.

Both commands warn on allowlist rot (`allowlistRotWarnings`) against registered table names.

## Snapshot parity (`schema:snapshot` / `postschema`)

After writing `reports/schema.snapshot.json` and `reports/schema.manifest.bin`, snapshot decodes the manifest and runs `runManifestDumpParityFile` against the committed dump unless `SPORTSDESK_SCHEMA_SKIP_DUMP_PARITY=1`.

Options come from `prodDumpParityOptionsFromEnv()` (defaults: strict prod-only tables and strict stale allowlist). Structural drift → exit **2**; expired allowlist under strict → exit **3**. Details: `docs/schema-sqlite-failure-mode-matrix.md`.

**Scope:** parity asserts **manifest ↔ committed dump**, not dump ↔ live prod. A green CI run means the registry-encoded manifest matches the checked-in snapshot of prod (plus allowlist policy), not that prod matches prod today.

## `captured_at` and `dump_lag`

- **`captured_at`** is when the dump was observed (prod read or baseline generation), **not** git commit time.
- Re-committing the same JSON must **not** rewrite `captured_at`; only `schema:dump-prod` (prod re-capture) or a fresh baseline without an existing outfile changes it. `schema:sync-prod-dump` copies the prior value when the outfile exists.
- **`dump_lag`**: operational metric = wall time minus `captured_at` (e.g. at commit, deploy, or manual review). Large lag means parity may pass while live prod has diverged; refresh with `schema:dump-prod` when ops needs a current snapshot.

## Fixture allowlist

Prod-only tables (in dump, not in manifest) fail strict parity unless listed under `allowlist`:

```json
"table_name": { "reason": "…", "review_by": "YYYY-MM-DD" | null }
```

- **`reason`**: required non-empty string (why the table is tolerated).
- **`review_by`**: optional expiry; past dates emit `[STALE]…` and fail under strict stale policy (exit **3**).
- **Rot (warnings, exit 0 alone):** entry for a table now in the registry (“promoted”), or for a table no longer in `tables` (“orphaned”).
- **`SPORTSDESK_SCHEMA_DUMP_ALLOWLIST_BYPASS=1`**: disables prod-only detection locally; **throws if `CI=true`** (`assertAllowlistBypassNotInCi`). No env-based allowlist injection in CI—only the committed fixture.

## `SPORTSDESK_SCHEMA_PARITY_LIVE` (one-off)

Set `SPORTSDESK_SCHEMA_PARITY_LIVE=1` **and** `SPORTSDESK_SCHEMA_DB` to a SQLite path. After dump parity, `schema_snapshot` runs `assertManifestMatchesLiveDb` (fresh capture from that file). Opt-in local/ops check; **not** the default CI gate. Does not update the fixture or `captured_at` in the repo.

## Honest scope summary

| Claim | Holds when |
|-------|------------|
| Manifest matches committed prod dump | Default snapshot parity (fixture present, not skipped) |
| Dump matches live prod | Only after explicit prod capture (`schema:dump-prod`) or a live parity run with current DB |
| Registry matches prod | Registry is source of truth for manifest; dump is evidence—reconcile via dump-prod + commit |
