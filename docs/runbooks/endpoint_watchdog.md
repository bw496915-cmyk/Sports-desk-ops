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
4. **TLS/protocol provenance** — `probeTls` (`Bun.connect`) records the negotiated TLS version,
   cipher, ALPN, authorization and peer certificate (`validTo`, issuer, subject). The diagnostic
   handshake offers `h2` + `http/1.1`; it is separate from the fetch, which negotiates its own
   ALPN. `--json` carries this as `tls` / `tlsError` on the host and on each `addressProbes` entry.

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

`--json` includes the resolver, per-host status/code, consecutive failures, addresses, TTLs,
cache stats, TLS provenance and the requested HTTP version. Human output names the resolver and prints one line per host.

## Diagnostic target overrides

`--port`, `--ip` and `--all-ips` are one-off diagnostics, not scheduler configuration. They require
`--dry-run` and exactly one `--host`, so they cannot mix the scheduled consecutive-failure counts.

```sh
bun run scripts/watchdog_endpoint_probe.ts --dry-run --host api.telegram.org --port 8443
bun run scripts/watchdog_endpoint_probe.ts --dry-run --host api.telegram.org --ip 149.154.166.110
bun run scripts/watchdog_endpoint_probe.ts --dry-run --host api.telegram.org --all-ips
bun run scripts/watchdog_endpoint_probe.ts --dry-run --host api.telegram.org --ip 149.154.166.110 --port 443
bun run scripts/watchdog_endpoint_probe.ts --dry-run --host api.telegram.org --http-version http1.1
bun run scripts/watchdog_endpoint_probe.ts --dry-run --host clob.polymarket.com --http-version http2
```

`--ip` dials the address while keeping the target hostname for TLS SNI and the HTTP `Host`
header, so certificate verification still runs against the name. The DNS lookup still runs
against the hostname and is reported separately; if DNS fails but the IP answers, the JSON shows
both. IPv6 literals are bracketed automatically, and the prefetch is skipped when dialing an IP.

### TLS, SNI and Host

The three names are distinct:

- **`tls.serverName`** (fetch) — SNI and the name the certificate is verified against.
  `servername` is the `node:tls` alias; `serverName` wins if both are set.
- **`hostname`** — the dial/URL host, not a TLS field. When `--ip` is set the URL host is the IP.
- **`Host` header** — HTTP-level routing (the HTTP/2 equivalent is `:authority`); we send the
  logical hostname.

With `--ip`, the probe therefore dials the IP, sends `Host: <hostname>`, and verifies the
certificate against `<hostname>`. Observed: no TLS option or a wrong `serverName` fails with
`ERR_TLS_CERT_ALTNAME_INVALID`; the correct name returns the endpoint's status.

The layers are independent, not aliases: measured 2026-11-17 with an echo endpoint — dial
`54.172.45.38`, TLS SNI `httpbin.org`, `Host: probe.example` — the server echoed
`Host: probe.example`. The runner sets `tls.serverName` and `headers.host` as separate options;
with `--ip`, SNI and Host currently both carry the target hostname, but neither is derived from
the dial address. A `Host` mismatch can therefore change HTTP routing without failing TLS.

### Protocols

- The HTTP probe is HTTPS-only; `--port` changes the port, not the scheme.
- `--http-version auto|http1.1|http2|http3` (aliases `h1`/`h2`/`h3`), default `auto`. It is
  diagnostic: it requires `--dry-run` and exactly one `--host`, and passes Bun fetch's
  `protocol` for that request. `http2`/`http3` are experimental in Bun 1.4.4.
- The TLS diagnostic ALPN follows the requested version: `http1.1` offers only `http/1.1`,
  `http2` only `h2`, `auto` offers both. For `api.telegram.org` `auto` negotiates
  TLSv1.3 / `h2` / `TLS_AES_256_GCM_SHA384`.
- `http3` is QUIC, not TLS-over-TCP: the TCP TLS provenance probe is skipped and `tlsError`
  says so. Direct `fetch(protocol: "http3")` succeeds against QUIC-capable endpoints
  (`cloudflare-quic.com` returned 200 on 2026-11-17); none of the current core hosts
  negotiated h3 in that sample, so the probe reports a fetch failure for them (and still
  requires a second consecutive failure before paging).
- `ws://` / `wss://` are a different protocol: the connection starts with an HTTP Upgrade,
  not a GET. The core-host HTTP probe does not speak that upgrade; use the explicit
  `--ws-url` diagnostic below, which has no state/paging and cannot combine with the target
  flags.
- `Bun.TLSOptions` exposes `ALPNProtocols`, `ciphers` and `secureOptions`, but no
  `minVersion`/`maxVersion`; the app's fetch defaults are left untouched.
- `tls` is diagnostic; the fetch result remains the gate.

`--all-ips` probes **every address returned by the lookup**, each with the same SNI/Host and a 5 s
timeout. Per-address status, latency and error land in the host's `addressProbes` array. The host
verdict still comes from the primary path (the hostname fetch, or the `--ip` override), so one bad
edge address is reported as a diagnostic rather than silently turning into a synthetic host
failure. `--json` reports `ip`, `allIps`, the effective `port`, and `addressProbes` per host.

## WebSocket diagnostic

```sh
bun run scripts/watchdog_endpoint_probe.ts --dry-run \
  --ws-url wss://ws.postman-echo.com/raw
```

`--ws-url` replaces the HTTP GET with a WebSocket upgrade:

- The URL must be `ws://` or `wss://` and carries host, port and path.
- It requires `--dry-run`; it cannot combine with `--host`/`--port`/`--ip`/`--all-ips`/
  `--http-version`; it writes no state and pages no Telegram.
- A successful upgrade is `101`; the verdict message says `WS 101`, and
  `--json` adds `mode: "websocket"` plus `wsUrl`. A refused handshake or a timeout is reported
  as `fetch-failed`.
- `wss` runs `probeTls` with ALPN `http/1.1` for TLS version/cipher/certificate provenance;
  `ws` is plaintext (`tls: null`, `tlsError` says so).
- Measured 2026-11-17: `wss://ws.postman-echo.com/raw` → `WS 101`, ALPN `http/1.1`.

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
