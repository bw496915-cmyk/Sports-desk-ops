#!/usr/bin/env bash
# Install, remove, or inspect the SportsDesk endpoint-watch LaunchAgent.
#
# The agent runs `scripts/watchdog_endpoint_probe.ts` every 15 minutes with Bun directly,
# `--no-env-file`, and Telegram credentials from the login keychain. It needs no `.env.op`, no
# `op`, and no service-account token; the state file lives under `scratch/watchdog/`.
#
# Usage:
#   scripts/install_endpoint_watch_agent.sh install
#   scripts/install_endpoint_watch_agent.sh uninstall
#   scripts/install_endpoint_watch_agent.sh status

set -euo pipefail

REPO_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.bookdeskops.sportsdesk.endpoint-watch"

usage() {
  cat >&2 <<'USAGE'
install_endpoint_watch_agent.sh install [--dry-run] | uninstall | status

  install    Substitute placeholders in the template, write chmod 0600 plist to
             ~/Library/LaunchAgents/, run `plutil -lint`, and `launchctl bootstrap` it.
             --dry-run prints the rendered target and bootstrap command without writing.
  uninstall  `launchctl bootout` the agent and remove the installed plist.
  status     Print `launchctl print` state for the agent.

The agent probes SPORTSDESK_CORE_HOSTS every 15 minutes (StartInterval 900) and pages
Telegram only after two consecutive failures. No `.env.op`/op token is needed.
USAGE
}

ACTION="${1:-}"
DRY_RUN=0
case "${ACTION}" in
  install|uninstall|status) ;;
  -h|--help)
    usage
    exit 0
    ;;
  "")
    usage
    exit 2
    ;;
  *)
    echo "error: unknown action '${ACTION}'" >&2
    usage
    exit 2
    ;;
esac
shift
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi
if [[ $# -gt 0 ]]; then
  echo "error: unknown argument '$1'" >&2
  usage
  exit 2
fi
if [[ "${DRY_RUN}" -eq 1 && "${ACTION}" != "install" ]]; then
  echo "error: --dry-run is only valid with install" >&2
  exit 2
fi

resolve_bun_bin() {
  local bun_bin
  bun_bin="$(command -v bun || true)"
  if [[ -z "${bun_bin}" && -x "${HOME}/.bun/bin/bun" ]]; then
    bun_bin="${HOME}/.bun/bin/bun"
  fi
  if [[ -z "${bun_bin}" ]]; then
    echo "error: 'bun' not found; install the pinned Bun 1.4.4+ before running install" >&2
    exit 1
  fi
  printf '%s' "${bun_bin}"
}

render_plist() {
  local bun_bin="$1"
  local template_plist="$2"
  local target_plist="$3"

  RENDER_TEMPLATE="${template_plist}" \
  RENDER_TARGET="${target_plist}" \
    "${bun_bin}" --no-env-file -e '
      import { chmodSync, readFileSync, writeFileSync } from "node:fs";
      const escapeXml = (value) =>
        value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      const templatePath = process.env.RENDER_TEMPLATE ?? "";
      const targetPath = process.env.RENDER_TARGET ?? "";
      const replacements = new Map([
        ["__OPERATOR_HOME__", process.env.RENDER_HOME ?? ""],
        ["__REPO_PATH__", process.env.RENDER_REPO ?? ""],
        ["__BUN_BIN__", process.env.RENDER_BUN_BIN ?? ""],
        ["__BUN_BIN_DIR__", process.env.RENDER_BUN_BIN_DIR ?? ""],
      ]);
      let xml = readFileSync(templatePath, "utf8");
      for (const [token, value] of replacements) {
        xml = xml.replaceAll(token, escapeXml(value));
      }
      writeFileSync(targetPath, xml, { encoding: "utf8", mode: 0o600 });
      chmodSync(targetPath, 0o600);
    '
}

cmd_install() {
  local bun_bin bun_bin_dir uid template_plist target_plist
  bun_bin="$(resolve_bun_bin)"
  bun_bin_dir="$(dirname "${bun_bin}")"
  uid="$(id -u)"
  template_plist="${REPO_PATH}/infra/launchd/${LABEL}.plist"
  target_plist="${HOME}/Library/LaunchAgents/${LABEL}.plist"

  if [[ ! -f "${template_plist}" ]]; then
    echo "error: template missing at ${template_plist}" >&2
    exit 1
  fi

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "dry-run: would render ${template_plist} -> ${target_plist}"
    echo "dry-run: would launchctl bootstrap gui/${uid} ${target_plist} with ${bun_bin}"
    return 0
  fi

  mkdir -p "${HOME}/Library/LaunchAgents" "${REPO_PATH}/scratch"
  RENDER_HOME="${HOME}" \
  RENDER_REPO="${REPO_PATH}" \
  RENDER_BUN_BIN="${bun_bin}" \
  RENDER_BUN_BIN_DIR="${bun_bin_dir}" \
    render_plist "${bun_bin}" "${template_plist}" "${target_plist}"

  plutil -lint "${target_plist}" >/dev/null
  launchctl bootout "gui/${uid}/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/${uid}" "${target_plist}"
  if ! launchctl print "gui/${uid}/${LABEL}" >/dev/null 2>&1; then
    echo "error: ${LABEL} did not load after bootstrap; inspect launchctl print" >&2
    exit 1
  fi
  echo "installed: ${target_plist}"
  echo "logs:  tail -f ${REPO_PATH}/scratch/endpoint-watch.stderr.log"
  echo "state: ${REPO_PATH}/scratch/watchdog/endpoint-probe-state.json"
}

cmd_uninstall() {
  local uid="${1:-$(id -u)}"
  local target_plist="${HOME}/Library/LaunchAgents/${LABEL}.plist"
  launchctl bootout "gui/${uid}/${LABEL}" 2>/dev/null || true
  if [[ -f "${target_plist}" ]]; then
    rm -f "${target_plist}"
    echo "removed: ${target_plist}"
  else
    echo "nothing to remove at ${target_plist}"
  fi
}

cmd_status() {
  local uid="${1:-$(id -u)}"
  echo "=== ${LABEL} ==="
  if launchctl print "gui/${uid}/${LABEL}" >/dev/null 2>&1; then
    launchctl print "gui/${uid}/${LABEL}" | grep -E 'state =|pid =|last exit code =|path =' || true
  else
    echo "not loaded"
  fi
}

case "${ACTION}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
esac
