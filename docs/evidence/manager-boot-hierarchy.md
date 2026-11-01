# Manager boot — downline hierarchy (`getListAgenstByAgent`)

**Primary sources (hypothesis ledger, oracle, gaps):** [manager-boot-primary-sources.md](./manager-boot-primary-sources.md)

How **manager.html** (RequireJS + jQuery, bundle **`manager.js?bust=1.0.280`**) loads the same envelope
we parse in `lib/f402_list_agents_by_agent.ts`. Observed **2026-11-01** via DevTools stack + minified
source fetch.

## Boot call chain

```
manager.html
  → config-manager.js → main-manager.js
  → getAccountInfo()     POST getAccountInfoOwner (JSON body, session agent id)
  → language.js change   locale JSON
  → language.change → setAccountInfo() → settings()
  → getCompleteHeriarchy()   // typo preserved in portal JS (inside settings, not setAccountInfo directly)
       $.ajax POST …/Manager/getListAgenstByAgent
```

Typical DevTools stack (top → bottom): `send` / `ajax` (jquery) → **`getCompleteHeriarchy`** →
`settings` → **`setAccountInfo`** → `language.js` `_change` → **`getAccountInfo`** → RequireJS module
load from **manager.html**.

## Wire request (in-page)

Built in `getCompleteHeriarchy` (manager.js ~60492):

| Field | Source |
|-------|--------|
| `agentID` | Manager module `ID` (logged-in agent) |
| `agentType` | `accountInfo.AgentType` (`"A"` or `"M"`) |
| `operation` | `"getListAgenstByAgent"` (misspelled **Agenst** on wire) |
| `RRO` | Shared util flag (typically `1`) |

Bundle `path` is `/qubic/api/Manager/`; on **www.fantasy402.com** the live URL is
**`/cloud/api/Manager/getListAgenstByAgent`** (same operation name).

Optional **`agentOwner`** appears on some manual/curl captures; the boot ajax object above does not
include it — probes may still send it when mirroring other Manager calls.

## Response use in the portal (client contract)

Success handler (same function):

| Wire key | Client assignment |
|----------|-------------------|
| `PLAYERS` | `manager.players` (full downline player list; **plaintext `Password` on each row**) |
| `GENERAL` | `setCompleteHeriarchy({ data: GENERAL })`, then `manager.agents = GENERAL` |
| `EXTRA` | `manager.server = EXTRA` |

The UI tree is built from **`GENERAL`** in **`baseHeriarchy`**: walks **`Level` 1–12**, trims/
uppercases `Login` / `AgentID`, nests by level — **not** by `SeqNumber`. `SeqNumber` still equals
**5183 + array index** on live captures and is useful for ordering and audits.

**Parser / oracle compat:** Match behavior of the **pinned** `manager.js` hash in
`verification/manager-boot-oracle/pinned/manifest.json` (not an idealized tree). Examples at bust
1.0.280: Level **13** dropped silently; Level **2** orphan nests under **`""`** (`p[t]` not `p[t][a]`).
When the pinned bundle changes, **`verify:manager-oracle-slices`** fails on stale `extracted/*`; update
slices and **compat tests together** — do not ossify old portal bugs against a new pin.

## Gate order (on the record)

Exit codes: **`0`** pass, **`1`** FAILED (broken tool / bad data), **`10`** BLOCKED (waiting on artifact).

| Gate | Command | Closure |
|------|---------|---------|
| (a) Slice ↔ pin | `verify:manager-oracle-slices` | wired |
| (h) BLOCKED vs FAILED | `lib/f402_gate_exit.ts` | wired |
| (n) Verifier synthetic | `test:har-redaction-verifier` | wired (green=ok, red=failed) |
| (i′) Real HAR shape | `capture:f402-har` + commit proof | **blocked** — bootstrapped profile or `--login` |
| (i) Production proof gate | `verify:manager-har-redaction-proof` | blocked until (i′) committed |
| (j) Production oracle | `verify:manager-oracle-production` | blocked until (i) ready + fixture |
| (k) Variance N≥3 | `verify:manager-oracle-variance` | blocked until (j) — [`manager-boot-variance-gate.md`](./manager-boot-variance-gate.md) |

**(i)** is not “someone hand-writes a fixture.” Run **`bun run capture:f402-har -- --login`** end-to-end;
the script runs **redact → sentinel sweep → proof JSON**. Commit HAR + proof only when sweep passes.
**(j)** extracts `GENERAL` from that proven capture path, then existing redaction + oracle snapshot gates apply.

Non-master rows get an empty `players[]` attached in memory (`AgentType !== "M"`).

## Related call (not the big blob)

**`getHeriarchy`** (manager.js ~33074): POST `{ agentID, operation: "getHeriarchy", RRO }` →
`setHeriarchy({ list: e.LIST })` for the hierarchy panel. Boot may hit **both** this and
**`getListAgenstByAgent`**; only the latter returns **`GENERAL` + `PLAYERS` + `EXTRA`**.

## Repo tooling

| Artifact | Role |
|----------|------|
| `lib/f402_list_agents_by_agent.ts` | Parse, normalize, summarize, redact passwords |
| `lib/f402_probe.ts` | `getListAgenstByAgent` in **manager-boot** suite |
| `scripts/capture/f402_probe.ts` | Live probe; logs hierarchy summary line on 2xx |
| `tests/fixtures/f402-list-agents-*` | Shape fixtures (no live secrets) |

**Capture hygiene:** never commit scratch JSON with real `PLAYERS[].Password`. Run
`redactListAgentsByAgentEnvelope` before logs or disk. Typical live size: **~2466** `GENERAL`,
**~57762** `PLAYERS` (`F402_PLAYERS_TYPICAL_COUNT`).

## Speculative / retired

`POST /cloud/api/Manager/getAgentTree` remains **tier C** (DOM/crawler inference). Real boot hierarchy
is **`getListAgenstByAgent`** + **`getHeriarchy`** per manager.js, not `getAgentTree`.

## Bun-native capture stack (implementation map)

APIs are sourced from the right doc page (Utils vs File I/O vs Process vs Hashing), not assumed from
one Utils listing.

| Need | Module / API |
|------|----------------|
| `PLAYERS_MODE` default **off** | `lib/f402_hierarchy_config.ts` — `Bun.env` |
| Stream / jq filter | `lib/f402_hierarchy_envelope.ts` — `Bun.which("jq")` + Process `Bun.spawn`, in-process fallback |
| Trace + step timing | `lib/f402_hierarchy_trace.ts` — `Bun.randomUUIDv7`, `Bun.nanoseconds`, `Bun.inspect.table` (`DEBUG_TRACE`) |
| Safe console of envelopes | `lib/f402_hierarchy_envelope_view.ts` — `Bun.inspect.custom` + `lib/f402_hierarchy_redact.ts` |
| Capture log | `lib/f402_hierarchy_redact_log.ts` — File I/O `Bun.file().writer()`, `F402_CAPTURE_LOG` |
| Boot dedupe | `lib/f402_hierarchy_dedupe.ts` — `Bun.deepEquals(last, next, true)` |
| Tree hash / fingerprint | `lib/f402_hierarchy_hash.ts` — **`crypto.subtle.digest("SHA-256")`** (portable) |
| At-rest pack | `lib/f402_hierarchy_pack.ts` — **`Bun.zstdCompress`** (async) |
| PLAYERS memory evidence | `lib/f402_hierarchy_memory.ts` — `estimateShallowMemoryUsageOf` on one row (`bun:jsc`) |
| Collisions / level drift | `lib/f402_hierarchy_agents.ts` → `F402_AUDIT_DB` quarantine |
| Audit / drift / quarantine | `lib/f402_hierarchy_audit.ts` — `bun:sqlite` WAL |
| CLI entry | `scripts/capture/f402_hierarchy_probe.ts` — **`import.meta.path === Bun.main`** |
| WebView probe sidecar | `capture:f402` → `getListAgenstByAgent.players-<mode>.json` |

Portal **`setTimeout(..., 500)`** before `getCompleteHeriarchy` on Tile Menu is a UI delay, not a
correctness gate — probes await fetch; use `withTrace` to measure steps instead of guessing 500ms.

**Still separate docs:** `Bun.CryptoHasher` / `Bun.hash` (Hashing), `Bun.serve` dashboard (HTTP),
AES-256-GCM at-rest (`node:crypto` + optional `--zstd-out`), Worker tree build.
