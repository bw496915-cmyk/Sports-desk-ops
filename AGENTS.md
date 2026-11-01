# AGENTS.md — sportsdesk-ops

Operator tooling for the Fantasy402 sports desk: ingestion, settlement, combo/CLV analytics, the R2
portal and the VPS service. 397 TypeScript files, 89 scripts, 139 tests. Bun **1.4.4**.

## Entrypoint and the gate chain

`./bin/dx` is the operator entrypoint (`README.md:11-15`); `deploy_to_vps.sh` / `./bin/dx deploy`
ship to the VPS. CI runs an eight-part chain — reproduce it locally in this order before claiming a
change works:

```sh
bun run format:check
bun run typecheck
bun run lint:check
bun run test:docs && bun run verify:docs        # docs invariants + docs gates
bun run schema:typecheck && bun run schema:check-fixture-drift
bun run verify:gen-tokens-gate
bun run check:fetch-init
bun run check:innerhtml
bun run test                                    # discovered tests, not only tests/
```

There is **no single `check` script** — these fragments exist only as CI steps, so a local run has
to be assembled. GitHub Actions cannot start on this private repo (startup_failure, 0 jobs), so a
green badge does not exist; the local chain _is_ the proof.

## Layout

`lib/` (ingestion, settlement, combo identity, venue stores) · `bin/` (dx, linters) ·
`tests/` (84 files) plus **colocated tests in `lib/` and `scripts/`** (~55 more — CI only runs
`tests/`, so run `bun test` before pushing) · `packages/` · `functions/` · `migrations/` ·
`docs/` · root runbooks (runtime shapes, guardrails, token architecture, R2/API, VPS domain).

## Hard rules

- **Production is read-only unless the task is explicitly a deploy.** Probe with `./bin/dx`, never
  mutate live data to make a number look right.
- **Evidence labelling:** any claim in docs or commits states what was measured and when. The docs
  gates exist because fabricated contracts shipped before.
- **Token/secret work** goes through the documented SSOT path; `.1password/environments.toml`
  currently has an **empty environment id**, so a fresh machine gets no `.env` — fix the wiring, do
  not hand-write secrets into the repo.
- `gs-manager-cli.zip` (31 KB) is untracked junk — do not commit it.
- `~/platform` is an external policy checkout (pinned SHA in `.github/workflows/ci.yml`); without
  it `policy`-based scripts fail. Say so instead of disabling them.

## Doc ownership

`README.md` = orientation + the runbook tree · the seven root runbooks = operational procedure ·
`docs/` = long-form. Move procedure into `docs/` rather than growing the root.
