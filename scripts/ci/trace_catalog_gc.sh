#!/usr/bin/env bash
# Run the existing offline catalog check once, with process-scoped CPU samples.
set -euo pipefail
trace_dir=${RUNNER_TEMP:?}/catalog-trace
symbol_dir=${RUNNER_TEMP}/catalog-symbols
mkdir -p "$trace_dir" "$symbol_dir"
docker build --build-arg "BASE_IMAGE=${IMAGE:?}" -t sportsdesk-catalog-trace - <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apk add --no-cache git perf binutils
DOCKERFILE
docker run --rm -v "$PWD:/desk" -w /desk --entrypoint bun sportsdesk-catalog-trace ci --no-env-file
archive="$symbol_dir/profile.zip"
curl -fsSL --retry 3 -o "$archive" https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64-musl-baseline-profile.zip
echo "69727f81cf19c7b9d97d6bc201b6ab50cd9dc05f021b7e074dbbd920c12011cf  $archive" | sha256sum -c -
unzip -jp "$archive" bun-linux-x64-musl-baseline-profile/bun-profile > "$symbol_dir/bun-profile"
chmod 755 "$symbol_dir/bun-profile"
mounts=(--rm --network none -v "$PWD:/desk:ro" -w /desk -v "$trace_dir:/trace" --entrypoint sh)
docker run "${mounts[@]}" --cap-add PERFMON -v "$symbol_dir/bun-profile:/symbols:ro" sportsdesk-catalog-trace -ec '
  test -e /lib/ld-musl-x86_64.so.1
  test "$(bun --revision)" = 1.4.4+38afee6c8
  readelf -n /usr/local/bin/bun | grep "Build ID:" > /tmp/runtime-id
  readelf -n /symbols | grep "Build ID:" > /tmp/symbol-id
  cmp /tmp/runtime-id /tmp/symbol-id
  cat /tmp/runtime-id /etc/alpine-release
  git config --global --add safe.directory /desk
  export SPORTSDESK_TRACE_CATALOG=1 BUN_JSC_logGC=1 NO_COLOR=1
  exec perf record --clockid realtime -F 499 -e cpu-clock:u --call-graph fp -o /trace/catalog.perf.data -- bun scripts/bun_shape_contracts.ts --check
' > "$trace_dir/catalog.log" 2>&1 || { tail -30 "$trace_dir/catalog.log"; exit 1; }
# Resolve addresses with the matching release symbols only after the measured process exits.
docker run "${mounts[@]}" -v "$symbol_dir/bun-profile:/usr/local/bin/bun:ro" sportsdesk-catalog-trace -ec '
  perf script -i /trace/catalog.perf.data --ns --no-call-graph -F pid,tid,time,ip,sym,dso > /trace/samples.txt
  chmod a+r /trace/catalog.perf.data /trace/samples.txt
'
