#!/usr/bin/env bash
# Usage: capture-drive.sh <evidence-dir> <basename> -- <command...>
set -euo pipefail
if [[ $# -lt 4 || "$3" != "--" ]]; then
  echo "usage: capture-drive.sh <dir> <basename> -- <command...>" >&2
  exit 2
fi
dir="$1"
base="$2"
shift 3
mkdir -p "$dir"
log="$dir/$base.log.txt"
set +e
(set -o pipefail; "$@" 2>&1 | tee "$log")
ec=$?
set -e
echo "$ec" > "$dir/$base.status.txt"
exit "$ec"
