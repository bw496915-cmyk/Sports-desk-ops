#!/usr/bin/env bash
# CI: regen token outputs and fail with an actionable message on drift.
set -euo pipefail
exec bun run scripts/gen_tokens_gate.ts
