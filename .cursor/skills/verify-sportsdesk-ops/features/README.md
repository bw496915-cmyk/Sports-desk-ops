# Sports-desk-ops verification map

User-facing and CI-facing behavior for the Bun CLI gates and token SSOT path. Read this index before driving; use one feature file per recipe.

## Baseline preconditions

- Repo root: `~/code/sportsdesk-ops` (or clone of Sports-desk-ops).
- `bun install --frozen-lockfile` completed.
- `SPORTSDESK_VERIFY_RUN_ID` set (see Launch in parent SKILL.md).
- Run `.cursor/skills/verify-sportsdesk-ops/bin/doctor.sh` before the first drive and after any failed drive.

## Driving conventions

- Each drive is a fresh shell from repo root unless the feature says otherwise.
- Capture exit code, stdout, and stderr into `$SPORTSDESK_VERIFY_EVIDENCE/<feature-id>/`.
- Do not commit generated token outputs or scratch evidence.

## Proof and skip reporting

- CLI proof: command line, exit code, and trimmed log under the evidence dir.
- Report unreachable features with the missing prerequisite (Java/mise for TLC, `CI=true` for full schema gate locally).
- Do not mark a feature verified through a different entry point than the map lists.

## Features

- [gen:tokens zero-drift gate](./gen-tokens-zero-drift-gate.md) — CI gate regen + diff + manifest.
- [gen:tokens strict-failure harness](./gen-tokens-mutant-harness.md) — replay-mutant proves skip fails closed.
- [Formal gen:tokens TLC check](./formal-gen-tokens-model.md) — `verify:gen-tokens-gate` / statechart.
- [Token design assertions](./token-design-assertions.md) — `tests/verify_tokens.test.ts` user-visible invariants.
- [Operator surfaces](./operator-surfaces.md) — `dx gslive/docs/stale/poll`, live ingest provenance, wire→feed mapping.
