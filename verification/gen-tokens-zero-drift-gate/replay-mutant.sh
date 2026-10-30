#!/usr/bin/env bash
# Prove the silent-skip hole on real code (mutates generate_tokens.ts, then restores).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
gen="$root/scripts/generate_tokens.ts"
bak="$(mktemp)"

cp "$gen" "$bak"
trap 'cp "$bak" "$gen"; rm -f "$bak"' EXIT

python3 - "$gen" <<'PY'
import sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
out: list[str] = []
for line in lines:
    if line.startswith("writeFileSync(domainBrandedTypesPath"):
        out.append(
            'console.log("[gen:tokens] VERIFY MUTANT skip domain-branded-types.ts");'
        )
        continue
    if "Emitted updated domain-branded-types.ts" in line:
        continue
    out.append(line)
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY

cd "$root"
set +e
bun run gen:tokens:gate
gate_exit=$?
set -e

if [[ "$gate_exit" -ne 0 ]]; then
  echo "replay-mutant: expected gen:tokens:gate exit 0 (false pass), got $gate_exit" >&2
  exit 1
fi

echo "replay-mutant: confirmed false pass when gen skips domain-branded-types.ts write"
