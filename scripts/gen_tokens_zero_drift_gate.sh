#!/usr/bin/env bash
# CI: regen token outputs and fail with an actionable message on drift.
set -euo pipefail

bun run gen:tokens

GENERATED=(
  domain-branded-types.ts
  customer-churn-simulation-dashboard.html
  telegram-miniapp-dashboard.html
)

failed=0
for f in "${GENERATED[@]}"; do
  if ! git diff --quiet -- "$f"; then
    echo "::error::${f} does not match gen:tokens output — run \`bun run gen:tokens\` and commit (do not hand-edit generated files)"
    git diff -- "$f"
    failed=1
  fi
done

exit "$failed"
