#!/usr/bin/env bash
# Source before drives: evidence dir + run id (does not start a server).
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../../" && pwd)"
export SPORTSDESK_VERIFY_REPO_ROOT="$root"
export SPORTSDESK_VERIFY_RUN_ID="${SPORTSDESK_VERIFY_RUN_ID:-$(date +%Y%m%d-%H%M%S-$$)}"
export SPORTSDESK_VERIFY_EVIDENCE="${SPORTSDESK_VERIFY_EVIDENCE:-$root/scratch/verify-sportsdesk-ops/$SPORTSDESK_VERIFY_RUN_ID}"
mkdir -p "$SPORTSDESK_VERIFY_EVIDENCE"
echo "SPORTSDESK_VERIFY_EVIDENCE=$SPORTSDESK_VERIFY_EVIDENCE"
