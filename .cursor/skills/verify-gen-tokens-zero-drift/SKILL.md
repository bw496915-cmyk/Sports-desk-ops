---
name: verify-gen-tokens-zero-drift
description: >-
  Model-check gen:tokens:gate zero-drift promises (scripts/gen_tokens_zero_drift_gate.sh,
  scripts/generate_tokens.ts, package.json gen:tokens:gate). Use when changing the gate,
  token generator, or verification/gen-tokens-zero-drift-gate/*.
---

# Verify gen:tokens zero-drift gate

**Property.** CI must not report a clean `gen:tokens:gate` when `gen:tokens` did not actually regenerate the committed outputs.

**Harm.** Stale or hand-edited generated token files ship while CI is green.

The check is a small TLA+ model (`verification/gen-tokens-zero-drift-gate/GenTokensGate.tla`) run with TLC via pstack **`/statechart`**. Read TLC output with **`/statechart`** (report paths, chart labels, hidden steps)—do not hardcode pstack install paths in updates; the runner discovers `statechart` or uses `PSTACK_STATECHART`.

Charts are rendered with [Pele](https://pele.run) (blueprint theme) into `verification/gen-tokens-zero-drift-gate/chart.svg`.

## Coverage record

| TLA+ action            | Code                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `RunGateDirty`         | `scripts/gen_tokens_gate.ts`: dirty check on `GEN_TOKEN_EMISSION_PATHS`          |
| `RunGateCleanCheckout` | `lib/gen_tokens/emission_targets.ts` targets with `reset: git-checkout-head`     |
| `RunGateCleanRm`       | targets with `reset: rm-before-gen` (`domain-branded-types.ts` full-from-toml)   |
| `GenCrash`             | non-zero `bun run gen:tokens`                                                    |
| `GenSkipStrict`        | `assertStrictGateEmission` under `GEN_TOKENS_GATE=1` (partial emit → gen exit 1) |
| `GenSkipAfterCheckout` | skip write with weak gate (`~strictGate`); manifest miss at gate                 |
| `GenSkipAfterRm`       | missing file after `rm` reset (weak gate path)                                   |
| `ManifestForged`       | `verifyManifestAgainstDisk` rejects stale or incomplete manifest                 |
| `GenOk`                | manifest lists all targets + matching sha256/run id + `git diff --quiet`         |
| `GenDrift`             | diff non-quiet                                                                   |

Files: `scripts/gen_tokens_gate.ts`, `lib/gen_tokens/emission_targets.ts`, `lib/gen_tokens/emission_manifest.ts`, `scripts/generate_tokens.ts`, `package.json` scripts `gen:tokens`, `gen:tokens:gate`, `verify:gen-tokens-gate`.

**Sync commit:** update after reconciling TLA+ with this table (typed SSOT parser + section 7 full-from-toml + manifest invariants).

**Last maintain (2026-10-30):** Strict gate + manifest variables in TLC; `domain-branded-types.ts` uses `rm-before-gen`.

## Expected result

**Exit 0** from `bun run verify:gen-tokens-gate` when the TLA+ model matches the manifest-based gate (`GenSkipStrict` → `Generator failed`, not pass).

**Exit 1** means a modeled invariant breaks — treat as regression or intentional promise change; do not weaken rules to greenwash.

Confirm skip is caught on real code: `bash verification/gen-tokens-zero-drift-gate/replay-mutant.sh` must exit **0** (gate failed on skip via strict gen abort).

## Assumptions

- Three generated paths are one abstract output for skip/diff semantics (per-path sha256 is abstracted as `manifestOk`).
- `gen:tokens` is one step; crash vs skip vs ok vs drift is chosen nondeterministically in the model.
- Production sets `strictGate = TRUE` ( `GEN_TOKENS_GATE=1` ).
- Gate mode sets a run id; manifest records post-`bun fmt` sha256 per path.

Not modelled: per-file sha256 enumeration, concurrent editors, `tokens.toml` field validation.

## Run

```sh
cd <sportsdesk-ops-root> && bun run verify:gen-tokens-gate
```

Options: `--no-render` (TLC only). Writes `report.md`, `chart.mmd`, `chart.svg` under `verification/gen-tokens-zero-drift-gate/`. Scratch TLC output: `verification/gen-tokens-zero-drift-gate/out/` (gitignored).

**Not in CI** — do not add to `schema:gate` until exit 0 is expected.

## Prove it can still fail on real code

TLC counterexample above is necessary; confirm on the shell gate with:

```sh
bash verification/gen-tokens-zero-drift-gate/replay-mutant.sh
```

That script temporarily skips writing `domain-branded-types.ts`, runs `gen:tokens:gate`, expects gate **non-zero** (strict gen abort), then restores `generate_tokens.ts`.

## Read a result

- **Exit 1 on TLC:** replay counterexample; if real code cannot reach it, fix the model.
- **Exit 2:** Java/TLC/statechart missing — see `verification/gen-tokens-zero-drift-gate/README.md`.
- **Exit 0:** property holds in the model; re-read covered shell script and move sync commit forward.

## When the covered code changes

1. Diff covered files from the sync commit.
2. Update matching TLA+ actions; one shell step = one model action.
3. Run `bun run verify:gen-tokens-gate` and `replay-mutant.sh` if the gate logic changed.
4. Update this coverage table and sync commit.

For upkeep after merges that skipped this skill, use **`/maintain-formal-verification-skill`**.
