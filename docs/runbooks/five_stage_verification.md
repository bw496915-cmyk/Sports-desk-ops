# Five-stage verification (Bun 1.4.4)

Stages 1–4 are local and reversible; `bun run verify:five-stage` runs them in order and stops at the first failure. Stage 5 writes to R2 and is run by hand.

| Stage           | Command                                                          | Fails when                                                                                                      |
| --------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Install      | `bun install --frozen-lockfile --no-env-file`                    | `bun.lock` would change, or a `.env*` file would be needed                                                      |
| 2. Tokens       | `bun run --filter '@sportsdesk/ops' gen:tokens:gate`             | `design/tokens.toml` breaks the v1.3.0 contract, a WCAG/CIEDE2000 floor, or the generated files drift (exit 70) |
| 3. CI gates     | `bun ./scripts/verify_ci_gates.ts` (`--json` for machine output) | any `scripts/bun_native_rules.ts` rule reports an error (exit 1)                                                |
| 4. Lint + types | `bun run lint:check && bun run typecheck`                        | oxlint (type-aware, deny warnings) or any `tsc` project fails                                                   |
| 5. Promote      | `bun ./scripts/r2_manifest_cas_promote.ts …`                     | the manifest changed since it was read (HTTP 412, exit 3)                                                       |

## Bun 1.4.4 notes

- There is no native `bun lint` in 1.4.4: `bun lint` runs the package's `lint` script, so a `lint` script that calls `bun lint` recurses. Stage 4 therefore uses the existing oxlint scripts (`lint:check` is non-mutating); `--type-aware` is an oxlint flag, not a Bun one.
- `bun.lock` is written with `lockfileVersion: 2` and `configVersion: 1` (isolated linker by default for workspaces); stage 3 asserts both.

## Stage 5: manifest promotion (If-Match CAS)

Promotes `manifests/a11y-gate/latest` and `manifests/spec-governance/latest` in bucket `sportsdesk-ops-reports`.

1. `stat()` reads the current ETag. It is quoted (`"…"`) and is sent back verbatim.
2. The current object is read with `arrayBuffer()`; identical bytes are a no-op.
3. The new bytes go up with a presigned PUT over plain `fetch` carrying `If-Match: <etag>` (or `If-None-Match: *` when the key is absent). `fetch("s3://…")` and `S3Client.write()` drop `If-Match` on 1.4.4, so they are not used.
4. HTTP 412 means another writer won: the script fails with `ERR_MANIFEST_CAS_CONFLICT_412` and exits 3. It never re-reads, rebases, or retries (max rebases 0); rerun stages 2–3 and promote again.

Credentials resolve through `lib/r2_s3_client.ts` (`Bun.secrets`, then `R2_*` / `S3_*` / `AWS_*`); the script never prints them. Do not set `S3_BUCKET` alongside `--bucket`.

Build the two manifests outside the repo (local `.json` artifacts are gated), then dry-run before the live promotion:

```sh
out="$(mktemp -d)"
bun ./packages/sportsdesk-ops/src/cli/gen-tokens.ts --check --a11y-report "$out/a11y-gate.json"
bun ./scripts/verify_ci_gates.ts --json > "$out/spec-governance.json"
bun ./scripts/r2_manifest_cas_promote.ts --dry-run --a11y-gate "$out/a11y-gate.json" --spec-governance "$out/spec-governance.json"
bun ./scripts/r2_manifest_cas_promote.ts --a11y-gate "$out/a11y-gate.json" --spec-governance "$out/spec-governance.json"
```

`scripts/r2_manifest_cas_promote.test.ts` covers this against a local mock S3 that enforces `If-Match`: the current quoted ETag gives 200, a stale or unquoted one gives 412.
