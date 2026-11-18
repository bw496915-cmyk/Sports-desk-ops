# Endpoint watchdog

Independent 15-minute DNS + HTTPS reachability check for the desk's core external hosts. It pages
Telegram only after **two consecutive failures**; one probe miss is noise, two is a signal. It is a
separate LaunchAgent from the F402 session watchdog — a stale refresh journal and an unreachable
endpoint are different failure classes at different cadences.

## What it probes

Targets come from `SPORTSDESK_CORE_HOSTS` in `lib/bun_dns.ts` (six hosts, each with a port and
service name). The runner never carries a second host list.

For each target, per tick:

1. **DNS** — `Bun.dns.lookup` with the endpoint `port` and `socketType: "tcp"` (mirroring
   `fetch`/`Bun.connect`); family stays unset (dual-stack) so an IPv4-only host still resolves.
   The [resolver backend](https://bun.sh/reference/bun/dns#dns-resolver-client) is left at Bun's
   platform default (c-ares on Linux, system/getaddrinfo on macOS) because the probe must measure
   the path the app takes; `--backend` is a diagnostic override only. The reference warns
   `getaddrinfo` is the slow path under concurrent loads; that is noted, not overridden. The docs
   note port distinguishes IPv6 vs IPv4-only connections.
2. **Warm-up** — [`Bun.dns.prefetch(host, port)`](https://bun.sh/reference/bun/dns/prefetch) before the fetch. The reference documents the hand-off; measured to let the
   later `fetch()` skip a lookup. Experimental; it never decides the verdict.
3. **Reachability** — `GET https://host:port/` with a 5 s timeout and `redirect: "manual"`. A 3xx or
   4xx response is reachable (Telegram's API root answers 404 by design); no response or a 5xx is a
   failure.

Each step is bounded: DNS lookup 5 s, fetch 5 s. A per-target failure is isolated — one host's
failure does not blank the others.

## Verdict and state

- A failed probe increments that host's `consecutiveFailures`; a success resets it to 0.
- The runner pages when `consecutiveFailures >= 2`.
- State: `scratch/watchdog/endpoint-probe-state.json` (schema version 1, one entry per host).
  It is written atomically and pruned to current core hosts. A malformed state file exits `2`
  rather than silently resetting the counts.
- `--dry-run` probes and prints but writes no state and sends no page.

Diagnostics are not gates: DNS [`ttlSeconds`](https://bun.sh/reference/bun/DNSLookup) (per answer) and Bun cache stats (`getCacheStats`) are
reported in `--json` only. They describe the resolver/cache, not whether the endpoint answered.

## Exit codes

| Code | Meaning                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| `0`  | Every selected host is healthy, or `--dry-run` completed                                                       |
| `1`  | At least one host alerted and the Telegram page was sent                                                       |
| `2`  | Could not evaluate or alert (bad state file, unknown host/backend, missing Telegram credentials, send failure) |

## Install

```sh
scripts/install_endpoint_watch_agent.sh install --dry-run # print the render + bootstrap, write nothing
scripts/install_endpoint_watch_agent.sh install           # render, plutil -lint, bootstrap, verify loaded
scripts/install_endpoint_watch_agent.sh status    # launchctl print state
scripts/install_endpoint_watch_agent.sh uninstall # bootout + remove the plist
```

`install` checks `launchctl print` after bootstrap and exits `1` if the agent did not load.

The agent is `com.bookdeskops.sportsdesk.endpoint-watch`; the template is
`infra/launchd/com.bookdeskops.sportsdesk.endpoint-watch.plist`. It runs Bun with
`--no-env-file`, `StartInterval 900`, `RunAtLoad`, and no `KeepAlive` — each tick is a one-shot,
idempotent check.

Logs: `scratch/endpoint-watch.stdout.log`, `scratch/endpoint-watch.stderr.log`.

Telegram credentials come from the login keychain via `resolveTelegramCredentials`; the plist
carries no token and no `.env.op`/`op` dependency.

## Manual runs

```sh
bun run scripts/watchdog_endpoint_probe.ts --dry-run --json          # all core hosts, no side effects
bun run scripts/watchdog_endpoint_probe.ts --dry-run --host api.telegram.org
bun run scripts/watchdog_endpoint_probe.ts --dry-run --backend system --host api.telegram.org
```

`--json` includes the resolver, per-host status/code, consecutive failures, addresses, TTLs and
cache stats. Human output names the resolver and prints one line per host.

## Troubleshooting

- **Exit 2 with "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are unavailable"** — the keychain lookup did
  not find the credentials under launchd; check the stderr log and run the manual command from an
  interactive login to compare.
- **Exit 2 with a state/schema error** — inspect
  `scratch/watchdog/endpoint-probe-state.json`; delete it only deliberately, because that resets
  the consecutive-failure counts.
- **`unknown --host`** — only `SPORTSDESK_CORE_HOSTS` hostnames are accepted; add the host to
  `lib/bun_dns.ts` if it is a genuine core target.
- **One host failing while others pass** — the runner reports per host; check DNS first, then the
  endpoint's TLS/HTTP status. A 4xx alone is not a failure.

This runbook covers the endpoint watchdog only. The F402 session-refresh watchdog and its journal
are documented separately in [`f402_session_refresh.md`](./f402_session_refresh.md).

## References

- [`Bun.dns.lookup`](https://bun.sh/reference/bun/dns#basic-usage) — options
- [DNS resolver client](https://bun.sh/reference/bun/dns#dns-resolver-client) — c-ares / system /
  getaddrinfo / libc
- [`Bun.dns.prefetch`](https://bun.sh/reference/bun/dns/prefetch) — warm-up for a later fetch
- [`DNSLookup`](https://bun.sh/reference/bun/DNSLookup) — `ttl` is c-ares-only
