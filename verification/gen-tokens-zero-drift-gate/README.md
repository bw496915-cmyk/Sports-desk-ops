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

**Expected exit code:** `0` when the TLA+ model matches the manifest-based gate in `scripts/gen_tokens_gate.ts`.

Exit `1` means a modeled invariant broke — treat as regression.

## Bootstrap

First TLC run needs Java 11+ and `tla2tools.jar`. pstack `statechart` installs them via `mise` when available. Otherwise set `TLA2TOOLS` and `JAVA`. Optional: `PSTACK_STATECHART` points at the `statechart` shell wrapper.

## Scope

Models `scripts/gen_tokens_zero_drift_gate.sh` as one abstract output file and two reset strategies (`checkout` vs `rm`). Does not model per-file partial writes, splice anchors in `generate_tokens.ts`, or `tokens.toml` content.

## Real-code replay

```sh
bash verification/gen-tokens-zero-drift-gate/replay-mutant.sh
```

Temporarily skips the `domain-branded-types.ts` `emitRepoFile` call, runs `gen:tokens:gate`, expects **non-zero** (manifest miss), then restores the generator.
