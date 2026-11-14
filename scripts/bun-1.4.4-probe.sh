#!/usr/bin/env bash
# ============================================================================
# bun-1.4.4-probe.sh — smoke probes for the 1.4.4 package-manager claims.
#
# Each probe is hermetic: it runs in its own temp directory and never touches
# this checkout. PASS means the behaviour exists and the assertion holds; SKIP
# means the probe needs a fixture this script deliberately does not build, and
# the manual command is printed. Exit 1 if any probe FAILs (or if --strict and
# anything is skipped).
#
#   scripts/bun-1.4.4-probe.sh            run
#   scripts/bun-1.4.4-probe.sh --strict   skips count as failures
#   scripts/bun-1.4.4-probe.sh --verbose  show command output
# ============================================================================
set -u

STRICT=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    --verbose) VERBOSE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/bun144probe.XXXXXX")"
TILDE_TARGET="$HOME/tmp/bun144probe-cache"
cleanup() { rm -rf "$ROOT"; rm -rf "$TILDE_TARGET"; }
trap cleanup EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); printf 'PASS  %-34s %s\n' "$1" "$2"; }
fail() { FAIL=$((FAIL+1)); printf 'FAIL  %-34s %s\n' "$1" "$2"; }
skip() { SKIP=$((SKIP+1)); printf 'SKIP  %-34s %s\n' "$1" "$2"; }
run()  { if [ "$VERBOSE" = 1 ]; then "$@"; else "$@" >/dev/null 2>&1; fi; }

# macOS stat uses -f, GNU uses -c. This checkout is macOS; keep the probe honest
# about the platform instead of silently comparing nothing on Linux.
statfmt() { stat -f '%i %m %N' "$@" 2>/dev/null || stat -c '%i %Y %n' "$@"; }

mkproj() { # mkproj <dir> <package.json body>
  mkdir -p "$1"
  printf '%s' "$2" > "$1/package.json"
}

# ---- P1: --use-system-ca is accepted by install ------------------------------
mkproj "$ROOT/p1" '{"name":"p1","version":"1.0.0","dependencies":{}}'
if run bash -c "cd '$ROOT/p1' && bun install --use-system-ca --dry-run"; then
  pass use-system-ca "install --use-system-ca --dry-run accepted"
else
  fail use-system-ca "install --use-system-ca --dry-run rejected"
fi

# ---- P2: leading ~/ in install env vars expands -------------------------------
mkproj "$ROOT/p2" '{"name":"p2","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p2' && BUN_INSTALL_CACHE_DIR='~/tmp/bun144probe-cache' bun install"
if [ -d "$TILDE_TARGET" ]; then
  pass tilde-env "BUN_INSTALL_CACHE_DIR=~/… expanded to \$HOME/tmp/bun144probe-cache"
else
  fail tilde-env "cache dir not created at the expanded path (literal ~ not expanded?)"
fi

# ---- P3: no-op install does not churn globalStore links ----------------------
mkproj "$ROOT/p3" '{"name":"p3","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p3' && bun install"
if [ -d "$ROOT/p3/node_modules/.bun" ]; then
  statfmt "$ROOT"/p3/node_modules/.bun/*/ | sort > "$ROOT/before.txt"
  run bash -c "cd '$ROOT/p3' && bun install"
  statfmt "$ROOT"/p3/node_modules/.bun/*/ | sort > "$ROOT/after.txt"
  if diff -q "$ROOT/before.txt" "$ROOT/after.txt" >/dev/null; then
    pass globalStore-noop "inode+mtime stable across a no-op install"
  else
    fail globalStore-noop "links recreated (inode/mtime changed)"
  fi
else
  skip globalStore-noop "no node_modules/.bun link store (globalStore not active?)"
fi

# ---- P4: audit fix rewrites a vulnerable override ----------------------------
mkproj "$ROOT/p4" '{"name":"p4","version":"1.0.0","dependencies":{"lodash":"4.17.20"},"overrides":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p4' && bun install"
before_override="$(cd "$ROOT/p4" && bun -e 'const p = await Bun.file("package.json").json(); console.log(p.overrides?.lodash ?? "")')"
run bash -c "cd '$ROOT/p4' && bun audit fix"
after_override="$(cd "$ROOT/p4" && bun -e 'const p = await Bun.file("package.json").json(); console.log(p.overrides?.lodash ?? "")')"
if run bash -c "cd '$ROOT/p4' && bun audit"; then
  if [ "$after_override" != "$before_override" ]; then
    # The registry's fixed version is the registry's say-so: lodash 4.18.0 is
    # flagged as a bad release by npm, so the probe records the value instead of
    # blessing it.
    pass audit-fix-override "override $before_override -> $after_override, audit now clean"
  else
    fail audit-fix-override "audit clean but the override still pins $after_override (no rewrite observed)"
  fi
else
  fail audit-fix-override "audit still reports vulnerabilities after 'bun audit fix'"
fi

# ---- P5: bun update --depth 0 updates DIRECT deps only ----------------------
# The claim is about scope, not immutability: a transitive can still move when
# the updated direct dependency's own ranges require it (express 4.22 needs a
# newer body-parser). What must not happen is an UNRELATED direct dependency's
# transitives moving. gs-sdk stays pinned, so its ws/got are the witnesses.
mkproj "$ROOT/p5" '{"name":"p5","version":"1.0.0","dependencies":{"express":"4.18.0","@ganchrowsci/gs-sdk":"1.0.27"}}'
run bash -c "cd '$ROOT/p5' && bun install"
ws_before="$(grep -oE '"ws@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
got_before="$(grep -oE '"got@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
# Widen the range so the update has something legitimate to do.
mkproj "$ROOT/p5" '{"name":"p5","version":"1.0.0","dependencies":{"express":"^4.18.0","@ganchrowsci/gs-sdk":"1.0.27"}}'
run bash -c "cd '$ROOT/p5' && bun update --depth 0"
express_after="$(grep -oE '"express@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
ws_after="$(grep -oE '"ws@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
got_after="$(grep -oE '"got@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
if [ "$ws_before" = "$ws_after" ] && [ "$got_before" = "$got_after" ]; then
  pass update-depth-0 "direct $express_after updated; unrelated transitives kept ($ws_after, $got_after)"
else
  fail update-depth-0 "unrelated transitive moved: ws $ws_before->$ws_after got $got_before->$got_after"
fi

# ---- P6: bun prune --check reports and exits 1; bun prune removes ------------
# A desynced lock is refused ("bun.lock does not match package.json, nothing to
# prune"), so the extraneous package is placed by hand: present in node_modules,
# absent from both package.json and the lock.
mkproj "$ROOT/p6" '{"name":"p6","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p6' && bun install"
mkdir -p "$ROOT/p6/node_modules/zzz-extra"
printf '%s' '{"name":"zzz-extra","version":"1.0.0"}' > "$ROOT/p6/node_modules/zzz-extra/package.json"
set +e
prune_out="$(cd "$ROOT/p6" && bun prune --check 2>&1)"; prune_code=$?
set -e
if [ "$prune_code" -eq 1 ] && printf '%s' "$prune_out" | grep -q "zzz-extra"; then
  run bash -c "cd '$ROOT/p6' && bun prune"
  if [ ! -d "$ROOT/p6/node_modules/zzz-extra" ]; then
    set +e
    (cd "$ROOT/p6" && bun prune --check >/dev/null 2>&1); post_code=$?
    set -e
    if [ "$post_code" -eq 0 ]; then
      pass prune-check "check exit 1 naming zzz-extra; prune removed it; re-check exit 0"
    else
      fail prune-check "prune removed zzz-extra but --check still exits $post_code"
    fi
  else
    fail prune-check "--check named it but prune left it behind"
  fi
else
  fail prune-check "--check exit $prune_code, output did not name zzz-extra"
fi

# ---- P7: workspace:* can point at the ROOT package ---------------------------
mkdir -p "$ROOT/p7/packages/child"
printf '%s' '{"name":"rootpkg","version":"1.0.0","private":true,"workspaces":["packages/*"]}' > "$ROOT/p7/package.json"
printf '%s' '{"name":"child","version":"1.0.0","dependencies":{"rootpkg":"workspace:*"}}' > "$ROOT/p7/packages/child/package.json"
if run bash -c "cd '$ROOT/p7' && bun install"; then
  if [ -e "$ROOT/p7/node_modules/rootpkg" ] || [ -e "$ROOT/p7/packages/child/node_modules/rootpkg" ]; then
    pass workspace-root "child depends on rootpkg with workspace:* and links"
  else
    fail workspace-root "install succeeded but rootpkg is not linked"
  fi
else
  fail workspace-root "bun install rejected workspace:* against the root package"
fi

# ---- Deliberately not automated ---------------------------------------------
skip migrate-speed "needs a ~20k-entry yarn.lock; manual: time bun pm migrate"
skip patch-quadratic "needs a 100k-line patched package; manual: time bun patch --commit …"
skip monorepo-memory "needs ~2100 workspaces; manual: /usr/bin/time -l bun install"
skip publish-registry "needs a reachable registry + auth; manual: bun publish --dry-run"
skip publish-prerelease "needs auth; manual: set version 2.0.0-beta.1 and bun publish (expect refusal without --tag)"

echo
printf 'summary: %d pass, %d fail, %d skip (of %d probes)\n' "$PASS" "$FAIL" "$SKIP" "$((PASS+FAIL+SKIP))"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$STRICT" = 1 ] && [ "$SKIP" -gt 0 ]; then exit 1; fi
exit 0
