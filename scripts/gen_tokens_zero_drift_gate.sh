#!/usr/bin/env bash
# CI: regen token outputs and fail with an actionable message on drift.
set -euo pipefail

GENERATED=(
  domain-branded-types.ts
  customer-churn-simulation-dashboard.html
  telegram-miniapp-dashboard.html
)

if ! git diff --quiet -- "${GENERATED[@]}"; then
  echo "::error::generated token outputs are dirty — commit or stash before running gen:tokens:gate"
  git diff --stat -- "${GENERATED[@]}"
  exit 1
fi

# Reset to committed bytes, then regen must reproduce them. (Full rm pre-gen is unsafe:
# generate_tokens.ts reads existing files for splice anchors — see issue #tokens-ssot.)
git checkout HEAD -- "${GENERATED[@]}"

if ! bun run gen:tokens; then
  echo "::error::gen:tokens exited non-zero — fix scripts/generate_tokens.ts or tokens.toml (drift check skipped)"
  exit 1
fi

failed=0
for f in "${GENERATED[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "::error::gen:tokens did not write ${f}"
    failed=1
    continue
  fi
  if ! git diff --quiet -- "$f"; then
    echo "::error::${f} does not match gen:tokens output — run \`bun run gen:tokens\` and commit (do not hand-edit generated files)"
    git diff -- "$f"
    failed=1
  fi
done

exit "$failed"
