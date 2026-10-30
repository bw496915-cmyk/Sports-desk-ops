#!/usr/bin/env bash
# CI: regen token outputs and fail with an actionable message on drift.
set -euo pipefail

GENERATED=(
  domain-branded-types.ts
  customer-churn-simulation-dashboard.html
  telegram-miniapp-dashboard.html
)

for f in "${GENERATED[@]}"; do
  git checkout -- "$f"
done

if ! bun run gen:tokens; then
  echo "::error::gen:tokens exited non-zero — fix scripts/generate_tokens.ts or tokens.toml (drift check skipped)"
  exit 1
fi

failed=0
for f in "${GENERATED[@]}"; do
  if ! git diff --quiet -- "$f"; then
    echo "::error::${f} does not match gen:tokens output — run \`bun run gen:tokens\` and commit (do not hand-edit generated files)"
    git diff -- "$f"
    failed=1
  fi
done

exit "$failed"
