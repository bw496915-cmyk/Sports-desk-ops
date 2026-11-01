#!/usr/bin/env bash
# Prove the gate catches a partial gen (mutates generate_tokens.ts, then restores).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
gen="$root/scripts/generate_tokens.ts"
bak="$(mktemp)"

cp "$gen" "$bak"
restore() {
  cp "$bak" "$gen"
  rm -f "$bak"
  git -C "$root" checkout HEAD -- design/domain-branded-types.ts 2>/dev/null || true
}
trap restore EXIT

python3 - "$gen" <<'PY'
import sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
out: list[str] = []
i = 0
while i < len(lines):
    line = lines[i]
    if line.strip().startswith("emitRepoFile("):
        block = [line]
        i += 1
        while i < len(lines) and lines[i].strip() != ");":
            block.append(lines[i])
            i += 1
        if i < len(lines):
            block.append(lines[i])
            i += 1
        if any(
            "domain-branded-types.ts" in b or "DOMAIN_BRANDED_TYPES_PATH" in b
            for b in block
        ):
            out.append(
                'console.log("[gen:tokens] VERIFY MUTANT skip domain-branded-types.ts");'
            )
        else:
            out.extend(block)
        continue
    out.append(line)
    i += 1
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY

if ! grep -q "VERIFY MUTANT skip domain-branded-types.ts" "$gen"; then
  echo "replay-mutant: patch did not apply to $gen" >&2
  exit 1
fi

cd "$root"
set +e
bun run gen:tokens:gate
gate_exit=$?
set -e

if [[ "$gate_exit" -eq 0 ]]; then
  echo "replay-mutant: expected gen:tokens:gate exit non-zero (manifest miss on skip), got 0" >&2
  exit 1
fi

echo "replay-mutant: gate correctly failed when gen skips domain-branded-types.ts write"
