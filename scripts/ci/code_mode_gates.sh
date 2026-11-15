#!/usr/bin/env bash
# Sequential Code Mode gates: oracle freeze -> property/unit/guest tests -> mutation -> guest probe.
# Each gate must pass before the next runs; a survived mutant below the break threshold fails the run.
set -euo pipefail

echo "== [1/4] oracle freeze gate =="
bun run check:oracle-frozen

echo "== [2/4] bun test tests/code_mode =="
bun test tests/code_mode

echo "== [3/4] stryker run (thresholds: high 80 / low 60 / break 60) =="
stryker_rc=0
bunx stryker run || stryker_rc=$?
# In-place mutation restores files by content, dropping exec bits and symlink types. Put the
# tracked metadata back so the gate leaves the worktree as it found it — even when it fails.
bun run scripts/ci/restore_after_stryker.ts
[ "$stryker_rc" -eq 0 ] || exit "$stryker_rc"

echo "== [4/4] QuickJS guest probe =="
bun run tests/code_mode/guest_probe.ts

echo "code-mode gates: PASS"
