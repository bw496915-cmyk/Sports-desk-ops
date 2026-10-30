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

| TLA+ action | Code |
| ----------- | ---- |
| `RunGateDirty` | `scripts/gen_tokens_gate.ts`: dirty check on `GEN_TOKEN_EMISSION_PATHS` |
| `RunGateCleanCheckout` | `lib/gen_tokens/emission_targets.ts` targets with `reset: git-checkout-head` |
| `RunGateCleanRm` | targets with `reset: rm-before-gen` (none yet; models future full-file outputs) |
| `GenCrash` | non-zero `bun run gen:tokens` |
| `GenSkipAfterCheckout` | skip write → manifest miss → gate exit non-zero |
| `GenSkipAfterRm` | missing file after `rm` reset |
| `GenOk` | manifest lists all targets + `git diff --quiet` |
| `GenDrift` | diff non-quiet |

Files: `scripts/gen_tokens_gate.ts`, `lib/gen_tokens/emission_targets.ts`, `scripts/generate_tokens.ts`, `package.json` scripts `gen:tokens`, `gen:tokens:gate`, `verify:gen-tokens-gate`.

**Sync commit:** `4aa21db` — verification bundle and model confirmed against product gate at `81fefeb`. Update only after you diff covered files from `81fefeb` and reconcile the TLA+ model.

**Last maintain (2026-10-30):** Outcome **bug** (not drift). Product gate unchanged since `81fefeb`; model matches `gen_tokens_zero_drift_gate.sh`. TLC exit **1** (`NoSilentPassWhenGenSkips`); `replay-mutant.sh` exit **0** on real gate (false pass). Bug path since checkout reset (`35a2927`); dirty guard and `-f` check (`bf23486`) did not close skip-after-checkout.

## Expected result

**Exit 0** from `bun run verify:gen-tokens-gate` when the TLA+ model matches the manifest-based gate (`GenSkipAfterCheckout` → `Gate failed`, not pass).

**Exit 1** means a modeled invariant breaks — treat as regression or intentional promise change; do not weaken rules to greenwash.

Confirm skip is caught on real code: `bash verification/gen-tokens-zero-drift-gate/replay-mutant.sh` must exit **0** (gate failed on skip).

## Assumptions

- Three generated paths are one abstract output (same skip/diff semantics).
- `gen:tokens` is one step; crash vs skip vs ok vs drift is chosen nondeterministically in the model.
- `strategy = "checkout"` in Init matches production; `rm` branch models the discussed fix only.

Not modelled: partial multi-file writes, `tokens.toml` validation, HTML splice anchors, concurrent editors.

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

That script temporarily skips writing `domain-branded-types.ts`, runs `gen:tokens:gate`, expects gate **non-zero** (manifest miss), then restores `generate_tokens.ts`.

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
