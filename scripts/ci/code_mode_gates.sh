#!/usr/bin/env bash
# Sequential Code Mode gates: snapshot drift -> oracle freeze -> property/unit/guest tests ->
# mutation -> guest probe.
# Each gate must pass before the next runs; a survived mutant below the break threshold fails the run.
set -euo pipefail

echo "== [0/5] snapshot drift (skipped when the operator book is absent) =="
if [ -f data/customer-profiles.json ]; then
  bun run check:profile-snapshot
else
  echo "skip: data/customer-profiles.json is absent (CI checkout)"
fi

echo "== [1/5] oracle freeze gate =="
bun run check:oracle-frozen

echo "== [2/5] bun test tests/code_mode/*.test.ts =="
bun test tests/code_mode/*.test.ts

echo "== [3/5] stryker run (thresholds: high 80 / low 60 / break 60) =="
stryker_rc=0
bunx stryker run || stryker_rc=$?
# In-place mutation restores files by content, dropping exec bits and symlink types. Put the
# tracked metadata back so the gate leaves the worktree as it found it — even when it fails.
bun run scripts/ci/restore_after_stryker.ts
[ "$stryker_rc" -eq 0 ] || exit "$stryker_rc"

echo "== [4/5] QuickJS guest probe =="
bun run tests/code_mode/guest_probe.ts

echo "code-mode gates: PASS"
