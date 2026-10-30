# gen:tokens zero-drift gate — formal model

**Property:** CI must not report a clean `gen:tokens:gate` when `gen:tokens` did not actually regenerate the committed outputs.

**Harm:** Stale or hand-edited generated token files ship while CI is green.

**Tool:** TLA+ checked with TLC via pstack [`/statechart`](https://github.com/cursor/plugins) (see project skill `verify-gen-tokens-zero-drift`).

## Run

From repo root:

```sh
bun run verify:gen-tokens-gate
```

Options: `--no-render` (skip Pele SVG).

**Expected exit code today:** `1` — invariant `NoSilentPassWhenGenSkips` breaks on the as-built gate (`git checkout HEAD` then regen). See `report.md` and `chart.svg` after a run.

Exit `0` means the model’s rules all hold (e.g. after a gate fix such as `rm -f` pre-gen with a full-file generator).

## Bootstrap

First TLC run needs Java 11+ and `tla2tools.jar`. pstack `statechart` installs them via `mise` when available. Otherwise set `TLA2TOOLS` and `JAVA`. Optional: `PSTACK_STATECHART` points at the `statechart` shell wrapper.

## Scope

Models `scripts/gen_tokens_zero_drift_gate.sh` as one abstract output file and two reset strategies (`checkout` vs `rm`). Does not model per-file partial writes, splice anchors in `generate_tokens.ts`, or `tokens.toml` content.

## Real-code replay

```sh
bash verification/gen-tokens-zero-drift-gate/replay-mutant.sh
```

Temporarily skips writing `domain-branded-types.ts`, runs `gen:tokens:gate`, expects exit **0** (false pass), then restores the generator.
