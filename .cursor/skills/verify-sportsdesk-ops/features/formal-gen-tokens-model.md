# Formal gen:tokens TLC check

Maintainers run the TLA+ model via pstack `/statechart` to ensure gate invariants match the documented lifecycle (strict gate, manifest, rm reset).

## Sub-features

- `tlc-all-invariants` — `verify:gen-tokens-gate` exits 0 when model matches code.

## How to get to it (user POV)

- Run `bun run verify:gen-tokens-gate` (optional `--no-render` for CI-style check).

## Driving it with shell + bun + TLC

Preconditions:

- `doctor.sh` passes.
- Java 11+ and TLC available (pstack `statechart` via mise, or `TLA2TOOLS` + `JAVA`).

- **TLC drive.** Run `bun run verify:gen-tokens-gate --no-render` 2>&1 | tee `$SPORTSDESK_VERIFY_EVIDENCE/tlc/report.txt`. Exit code `0`. Report lists `Rules that hold` including `NoSilentPassWhenGenSkips`, `PassImpliesManifestOk`.
- **Proof.** Save `$SPORTSDESK_VERIFY_EVIDENCE/tlc/report.txt`; no `breaks` section in output.

## Gotchas

- First run may download Java/TLC through mise; document `PSTACK_STATECHART` if discovery fails.
- Read counterexamples with `/statechart` skill; do not hardcode pstack paths in new docs.
- Product code changes without updating `GenTokensGate.tla` show up here first.
