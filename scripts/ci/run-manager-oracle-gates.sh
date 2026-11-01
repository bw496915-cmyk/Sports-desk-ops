#!/usr/bin/env bash
# CI gate driver (bash — not Bun.$). Exit model:
#   0  → pass
#   10 → BLOCKED (artifact pending) → success + ::notice::
#   1+ → FAILED → fail the step
# `set -e` applies to the script; run_gate disables -e around each gate so exit 10 is handled
# explicitly (equivalent to Bun.$cmd.nothrow() — plain `await $cmd` would throw on 10).
set -euo pipefail

run_gate() {
  local name="$1"
  shift
  set +e
  "$@"
  local code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    echo "$name: pass"
    return 0
  fi
  if [ "$code" -eq 10 ]; then
    echo "::notice title=${name}::Gate BLOCKED (exit 10) — waiting on artifact, not a regression"
    return 0
  fi
  echo "$name: FAILED (exit $code)"
  return "$code"
}

run_gate "verify:manifest-consistency" bun run verify:manifest-consistency
run_gate "verify:manager-har-redaction-proof" bun run verify:manager-har-redaction-proof
run_gate "verify:manager-oracle-production" bun run verify:manager-oracle-production
run_gate "verify:manager-oracle-variance" bun run verify:manager-oracle-variance
