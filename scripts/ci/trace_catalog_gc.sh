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
# Register only three argument-free events on a private copy of the measured ELF.
# perf inherits the events into this workload and records the PID/TID with each hit.
docker run --rm --entrypoint cat sportsdesk-catalog-trace /usr/local/bin/bun > "$symbol_dir/bun"
chmod 755 "$symbol_dir/bun"
build_id() { readelf -n "$1" | awk '/Build ID:/ {print $3}'; }
runtime_id=$(build_id "$symbol_dir/bun")
test -n "$runtime_id"
test "$runtime_id" = "$(build_id "$symbol_dir/bun-profile")"
group="catalog_gc_$$"
events=/sys/kernel/tracing/uprobe_events
registered=()
remove_events() {
  for name in "${registered[@]}"; do
    echo "-:$group/$name" | sudo tee -a "$events" >/dev/null
  done
}
trap remove_events EXIT
nm --defined-only "$symbol_dir/bun-profile" > "$symbol_dir/symbols"
read -r vaddr fileoff < <(readelf -WS "$symbol_dir/bun" | awk '$2 == ".text" {print $4, $5}')
register_event() {
  local name=$1 symbol=$2 address offset
  address=$(awk -v s="$symbol" '$3 == s {print $1}' "$symbol_dir/symbols")
  [[ $address =~ ^[[:xdigit:]]+$ ]]
  printf -v offset '%x' "$((16#$address - 16#$vaddr + 16#$fileoff))"
  if ! echo "p:$group/$name $symbol_dir/bun:0x$offset" | sudo tee -a "$events"; then
    sudo tail -8 /sys/kernel/tracing/error_log >&2
    return 1
  fi
  registered+=("$name")
}
register_event concurrent _ZN3JSC9Collector18runConcurrentPhaseENS_11GCConductorE
register_event transition _ZN3JSC9Collector19finishChangingPhaseENS_11GCConductorE
register_event visit _ZN3JSC9CodeBlock13visitChildrenEPNS_6JSCellERNS_11SlotVisitorE
mounts+=(-v /sys/kernel/tracing:/sys/kernel/tracing:ro)
docker run "${mounts[@]}" --cap-add PERFMON -e "PHASE_GROUP=$group" -e "BUILD_ID=$runtime_id" \
  -v "$symbol_dir/bun:/usr/local/bin/bun:ro" sportsdesk-catalog-trace -ec '
  test -e /lib/ld-musl-x86_64.so.1
  test "$(bun --revision)" = 1.4.4+38afee6c8
  echo "Build ID: $BUILD_ID"
  cat /etc/alpine-release
  git config --global --add safe.directory /desk
  export SPORTSDESK_TRACE_CATALOG=1 BUN_JSC_logGC=1 NO_COLOR=1
  exec perf record --clockid mono -e cpu-clock/freq=499/u \
    -e "$PHASE_GROUP:concurrent/period=1/" -e "$PHASE_GROUP:transition/period=1/" -e "$PHASE_GROUP:visit/period=1/" \
    -o /trace/catalog.perf.data -- bun scripts/bun_shape_contracts.ts --check
' > "$trace_dir/catalog.log" 2>&1 || { tail -30 "$trace_dir/catalog.log"; exit 1; }
# Resolve addresses with the matching release symbols only after the measured process exits.
docker run "${mounts[@]}" -v "$symbol_dir/bun-profile:/usr/local/bin/bun:ro" sportsdesk-catalog-trace -ec '
  chmod a+r /trace/catalog.perf.data
  perf script -i /trace/catalog.perf.data --ns --show-lost-events -F sw:pid,tid,time,ip,sym,dso -F trace:pid,tid,time,event > /trace/samples.txt
  chmod a+r /trace/samples.txt
'
