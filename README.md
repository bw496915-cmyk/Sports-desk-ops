# SportsDesk & Fantasy402 Operations Suite

Production intelligence, downline risk surveillance, Cloudflare R2 backup, Qwen3.5-4B neuron token taxonomy, and automated reporting pipeline built on the **Bun runtime (v1.4+)** for SportsDesk and Fantasy402 books.

Repository: [bw496915-cmyk/Sports-desk-ops](https://github.com/bw496915-cmyk/Sports-desk-ops.git)

## Quick Start

```bash
cd /Users/nolarose/dotfiles/sportsdesk-ops

# 1. Inspect nominal branded types & domain invariants
bun run sportsdesk_cli.ts -b

# 2. Inspect Qwen3.5-4B (Layers 18-28) neuron token registry with TrueColor ANSI swatches
bun run sportsdesk_cli.ts -N

# 3. Verify design tokens, CIEDE2000 color distance, and WCAG contrast (592 assertions)
bun test tests/verify_tokens.test.ts

# 4. Compile tokens across TypeScript, Webview, and TMA dashboards (Zero-Drift SSOT)
bun run gen:tokens

# 5. Run all 10 test suites across headers, port cascade, proxy isolation, timeouts, and benchmarks (813 assertions)
bun test

# 6. Run 24h sniper surveillance
bun run sportsdesk_cli.ts winners -p 24h --limit 25

# 7. Generate all 7 auditable surveillance reports
./run_reports.sh --format table

# 8. Run 52-week bettor churn simulation
bun run simulate_bettor_churn_suite.ts
```

Repository lint uses exact-pinned Oxlint through Bun; stable Bun 1.4.4 does not
enable native `bun lint`. Run `bun run lint:check` for a read-only gate that
fails on warnings or errors, or `bun run lint` to apply safe fixes. CI runs lint
alongside token regeneration, the fetch/innerHTML gates, and the full tests.

Run `bun run format` to format the repository or `bun run format:check` for a
read-only check. `bunfig.toml` preserves the existing 80-column, two-space,
double-quote style with semicolons. Run `bun run typecheck` for Bun's native
strict, no-emit checker; `tsconfig.json` makes the previous inferred compiler
defaults explicit and includes the repository's source, tests, and declarations.
CI runs formatting and type checking before lint. Bun remains pinned to 1.4.4
in CI, with matching `@types/bun`; no Prettier or oxfmt package is required.

## Pinned Bun compatibility tests

Tests distinguish Fetch-spec requirements from behavior observed on Bun 1.4.4.
The pinned `Request` constructor retains GET/HEAD bodies and accepts spec-forbidden
methods. It also maps mixed-case `Delete` to `GET` and uppercases custom verbs.
These are compatibility differences, not application guarantees: use explicit
uppercase methods. `fetch` rejects nonempty GET/HEAD bodies before transmission.

String request bodies have no inferred Content-Type on this binary, and JSON
Blobs acquire `charset=utf-8`. Wire tests check explicit Content-Type headers
separately so application behavior does not depend on those inferences.

Subprocess fixtures await output writes and exit naturally while the parent
drains stdout and stderr concurrently. They assert complete byte content rather
than assuming unread pipes always deadlock or enforcing machine-speed thresholds.

## Runtime Architecture & Server Policies

### Server Port & Hostname Binding Policy

Server binding in `sportsdesk_webview_server.ts` adheres to Bun's native port resolution cascade:

1. `BUN_PORT`
2. `PORT`
3. `NODE_PORT`
4. Default fallback: `3000`

**SportsDesk Operational Policy**: Rather than overriding Bun's cascade in code, SportsDesk relies directly on native resolution. Production deployments configure `PORT=4020` inside `.env`, which Bun loads automatically at process initialization. When `startServer(options)` is called programmatically, `{ port, hostname, unix, development }` options allow explicit test or proxy overrides; when omitted, Bun resolves port and hostname natively (defaulting hostname to `0.0.0.0`).

### Static File Serving & Zero-Copy Policy

Static HTML surfaces (`customer-churn-simulation-dashboard.html` and `telegram-miniapp-dashboard.html`) are served via native `new Response(Bun.file(path))` lazy handles.

- **Zero-Copy Specification & Boundary Conditions**: Official Bun runtime documentation specifies kernel zero-copy transfer (`sendfile(2)` on Linux, `copyfile` on macOS) specifically for outbound client file uploads (`fetch(url, { method: "POST", body: Bun.file(...) })`). This optimization activates exclusively under four strict preconditions:
  1. Payload size strictly exceeds 32 KB (under 32 KB, direct in-memory buffer reads outperform kernel syscall setup).
  2. Unencrypted HTTP transport (no TLS encryption).
  3. Direct TCP connection (no intermediate HTTP/HTTPS proxy).
  4. Uncompressed transmission (no gzip/brotli transfer encoding).
- **Server Response Path Distinction**: On the server response path (`new Response(Bun.file(path))`), Bun constructs a lazy file handle pointer in user space without eagerly reading file bytes into memory buffers. Handle allocation takes ~0.38 µs (compared to 45.9 µs for `readFileSync`). However, whether the subsequent socket transmission leverages `sendfile(2)` or `writev`/`pread` is unproven in Bun's published documentation. SportsDesk avoids conflating upload zero-copy claims with response streaming.
- **Nginx Reverse Proxy & Unix Domain Socket Offloading**: In production, Nginx terminates public TLS 1.3 at port 443 and proxies traffic to Bun over an unencrypted local Unix domain socket (`/run/sportsdesk/webview.sock`) or loopback HTTP (`127.0.0.1:4020`). This topology eliminates TLS encryption overhead and TCP port exposure on the host.

### Outbound Fetch Hardening & Network Isolation

Outbound network operations across Telegram alerts, Cloudflare R2 backup, and Fantasy402 feeds are hardened against proxy hijacking, hanging connections, and transport vulnerabilities:

- **Bounded Execution Windows (`AbortSignal.timeout`)**: All outbound requests enforce strict timeouts via `signal: AbortSignal.timeout(timeoutMs)` (e.g., 5,000 ms for Telegram dispatch, 10,000 ms for R2 verification). Unbounded `fetch` awaits are eliminated.
- **Loopback Proxy Isolation (`NO_PROXY` / `proxy: false`)**: Bun resolves `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` on a per-request basis (`ALL_PROXY` acts as scheme-agnostic fallback). Ambient corporate or CI proxies trap loopback calls unless bypassed. SportsDesk configures `NO_PROXY=127.0.0.1,localhost,::1` across `.env`, `.env.example`, and `deploy_to_vps.sh`. In addition, internal services pass `{ proxy: false }` for guaranteed direct socket connections, explicit proxy objects respect `NO_PROXY` by default (overridable via `respectNoProxy: false`), and tunnel failures reject with `ERR_PROXY_TUNNEL` (verified by `tests/fetch_proxy_isolation.test.ts`).
- **HTTP Connection Pool Bounds (`BUN_CONFIG_MAX_HTTP_REQUESTS`)**: Set to `256` to align Bun's shared connection pool with peak alert burst throughput, preventing resource starvation.
- **Dedicated `Bun.FetchSession` & Pre-Warming**: `SportsDeskTelegramService` initializes a dedicated `Bun.FetchSession` with `tls: { rejectUnauthorized: true }`, isolating session credentials and connection reuse. Outbound connections are pre-warmed at boot via `fetch.preconnect("https://api.telegram.org")` to eliminate initial TLS handshake latency.
- **Zero Embedded Credentials & Insecure TLS Protection**: Validated by `tests/fetch_url_credentials.test.ts`, ensuring 0 plaintext `http(s)://user:pass@` strings in source code and 0 occurrences of `rejectUnauthorized: false`.

### Environment Variable Precedence & Type Merging

Bun automatically loads environment files at startup in strict order of increasing precedence:

1. `.env` (base configuration)
2. `.env.production`, `.env.development`, `.env.test` (evaluated based on `NODE_ENV`)
3. `.env.local` (**Exception**: strictly skipped when `NODE_ENV=test` to ensure deterministic test isolation)
4. `.env.production.local`, `.env.development.local`, `.env.test.local` (mode-specific local overrides)

TypeScript declaration merging in `env.d.ts` extends both `Bun.Env` and `NodeJS.ProcessEnv` with strict typing for all SportsDesk credentials (`PORT`, `BUN_SOCKET`, `NO_PROXY`, `BUN_CONFIG_MAX_HTTP_REQUESTS`, `F402_*`, `CLOUDFLARE_*`, `R2_*`, `TELEGRAM_*`), verified via `tests/env_types.test-d.ts`.

### Security Headers & Telegram Mini App Embedding

To ensure seamless embedding inside Telegram Web (`https://web.telegram.org`), Telegram mobile apps, and desktop clients without frame hijacking vulnerabilities:

- `X-Frame-Options` is **strictly absent** from all server response headers (the deprecated `ALLOWALL` directive is never sent).
- Embedding is governed exclusively by modern standards: `Content-Security-Policy: frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;`.

## Performance Telemetry & Micro-Benchmarks

Empirical measurements recorded via `tests/bench_server.test.ts` and `tests/sendfile_threshold.test.ts` on Bun v1.4.4 (macOS arm64):

| Surface / Operation                                | Manual Baseline Path             | Native Bun Path            | Measured Latency    | Throughput / Speedup                |
| :------------------------------------------------- | :------------------------------- | :------------------------- | :------------------ | :---------------------------------- |
| **JSON Serialization** (25 accounts)               | `JSON.stringify` + headers       | `Response.json(data)`      | 0.99 µs vs 0.82 µs  | 1.21x faster                        |
| **Response Handle Construction** (21.5 KB payload) | `readFileSync` buffer allocation | `new Response(Bun.file())` | 45.91 µs vs 0.38 µs | 119.88x faster lazy handle creation |
| **Handle Construction Latency** (16 KB)            | Buffer allocation                | `new Response(Bun.file())` | 0.49 µs/op          | Sub-microsecond lazy handle         |
| **Handle Construction Latency** (64 KB)            | Buffer allocation                | `new Response(Bun.file())` | 0.47 µs/op          | Sub-microsecond lazy handle         |
| **Handle Construction Latency** (1 MB)             | Buffer allocation                | `new Response(Bun.file())` | 0.21 µs/op          | Sub-microsecond lazy handle         |
| **End-to-End Socket Transfer** (16 KB payload)     | `fetch` socket transfer          | `new Response(Bun.file())` | 0.149 ms/req        | Direct loopback socket transfer     |
| **End-to-End Socket Transfer** (64 KB payload)     | `fetch` socket transfer          | `new Response(Bun.file())` | 0.191 ms/req        | Direct loopback socket transfer     |
| **End-to-End Socket Transfer** (1 MB payload)      | `fetch` socket transfer          | `new Response(Bun.file())` | 0.489 ms/req        | Direct loopback socket transfer     |

## Qwen3.5-4B (Layers 18–28) Token Architecture & Single Source of Truth

The system uses `tokens.toml` as the authoritative **Single Source of Truth (SSOT)** for all 13 neuron tokens, dark surfaces, ingestion channels, and algorithmic routes:

- **Surface Tokens**: `--sd-surface-primary` (`#070b14`), `--sd-surface-card` (`#0b1329`).
- **Channel Ingestion Tokens (Axis 1)**:
  - `L18.N0204` (`#1d84b5`, Internet Retail Baseline, 1,500 ms SLA)
  - `L19.N0518` (`#64748b`, Blocked Sentinel Filter, `{ kind: 'sentinel_drop' }` policy)
  - `L20.N1105` (`#10b981`, Gateway Equilibrium & Vig Gate, 1,000 ms SLA)
  - `L21.N0884` (`#ef4444`, Alert Twin Syndicate Mirror, 250 ms SLA)
  - `L22.N1402` (`#f59e0b`, Builder Steam / Line Chase, 1,000 ms SLA) — _Single-owner Amber-500_
  - `L23.N0412` (`#28a745`, Live In-Play Whale Anomaly, 500 ms SLA)
  - `L24.N2019` (`#38bdf8`, CSLevel2 Recreational Longshot Bias, 2,000 ms SLA)
- **Algorithmic Route Tokens (Axis 2)**:
  - `L25.N1882` (`#06b6d4`, Route 02 Adverse Selection Devig Expansion)
  - `L26.N3104` (`#a855f7`, Route 03 CLV Margin Decay Sharp Shrinkage)
  - `L27.N0912` (`#d97706`, Route 01 Liquidity Exhaustion Breaker) — _Dedicated Amber-600_
  - `L28.N2501` (`#f43f5e`, Route 04 Terminal Risk Mitigation Limit Clamp)

### Decoupled Discriminated Union Typing

All channel transport SLAs and route thresholds are modeled with strict discriminated unions rather than overloaded primitive numbers or polymorphic strings:

```typescript
// Axis 1: Transport SLA Contract
export type TransportSla =
  | { readonly kind: "latency"; readonly latencySlaMs: number }
  | { readonly kind: "sentinel_drop" };

// Axis 2: Algorithmic Route Threshold Contract
export type RouteThreshold =
  | { readonly kind: "consensus_lag"; readonly maxConsensusLagMs: number }
  | { readonly kind: "bayes_shrinkage"; readonly tauStar: number; readonly minTicketCount: number }
  | { readonly kind: "liquidity_depth"; readonly minTopDepthCents: Cents }
  | { readonly kind: "composite_risk_gate"; readonly minToxicityScore: number; readonly maxHoldPercentage: number; readonly maxDeficitCents: Cents };

// Nominal Enum Enforcements
export enum TriggerPredicateKind { ... }
export enum MitigationActionKind { ... }
```

## Verification & CI Quality Gates

All tokens and contracts are verified continuously through `validation/token_validator.ts` and `tests/`:

1. **Zero Drift**: `bun run gen:tokens && git diff --exit-code` guarantees that `tokens.toml`, `domain-branded-types.ts`, `customer-churn-simulation-dashboard.html`, and `telegram-miniapp-dashboard.html` remain synchronized.
2. **24-bit Exact Uniqueness**: 13 unique `ColorHexInt` values derived from `Bun.color()`.
3. **CIEDE2000 Perceptual Separation ($\Delta E\_{00} \ge 7.0$)**: Mathematically verified color distance floor across all token pairs, preventing indistinguishable UI swatches.
4. **WCAG 2.1 Contrast Standards**: $\ge 3.0:1$ for graphical UI badges against dark surfaces (`#070b14` / `#0b1329`) and $\ge 4.5:1$ for typography.
5. **Zero Dead Tokens**: Asserts bidirectional reference consistency (all declared tokens used, all used tokens declared).

### Test Suite Classification (813 Assertions Total)

The test suite consists of 10 test suites across 34 tests and 813 total assertions:

- **Token Verification Suite (`tests/verify_tokens.test.ts`, 592 assertions)**:
  - **Table-Driven & Structural Tests (242 assertions)**:
    - Single Source of Truth & Zero-Drift Regeneration: 85 assertions
    - Color Uniqueness & Pairwise Evaluation: 11 assertions
    - WCAG 2.1 Contrast & Readability: 48 assertions
    - Discriminated Union Guardrails: 46 assertions
    - Dead-Token & Bi-Directional Reference Consistency: 52 assertions
  - **Generative Property-Based Tests (350 assertions)**:
    - `test_property_ciede2000_metric_axioms`: 150 assertions evaluating identity of indiscernibles, non-negativity, and symmetry across randomized color vectors.
    - `test_property_wcag_contrast_ratio_bounds`: 200 assertions evaluating contrast ratio bounds `[1.0, 21.0]` and monotonicity across randomized luminance pairs.
- **Server Runtime & Network Hardening Suites (221 assertions)**:
  - `tests/sendfile_threshold.test.ts`: 156 assertions evaluating 16 KB, 64 KB, and 1 MB lazy handle construction latency vs end-to-end socket throughput.
  - `tests/server_headers.test.ts`: 21 assertions verifying absence of `X-Frame-Options` and presence of required Telegram Mini App `frame-ancestors`.
  - `tests/server_error.test.ts`: 14 assertions verifying non-Error exceptions in production return structured 500 JSON without stack traces.
  - `tests/fetch_proxy_isolation.test.ts`: 12 assertions verifying `NO_PROXY`, `{ proxy: false }` direct bypass, and `respectNoProxy: false` overrides.
  - `tests/fetch_timeout.test.ts`: 7 assertions verifying `AbortSignal.timeout` aborts slow upstreams and validates service bounds.
  - `tests/bench_server.test.ts`: 6 assertions benchmarking latency numbers for JSON serialization and file handle creation.
  - `tests/fetch_url_credentials.test.ts`: 3 assertions auditing codebase for 0 embedded URL credentials and 0 `rejectUnauthorized: false` occurrences.
  - `tests/server_port.test.ts`: 2 assertions verifying `BUN_PORT=4100` cascade resolution without code overrides.
  - `tests/env_types.test-d.ts` / `tests/env_types.test.ts`: Type assertion verifying `expectTypeOf<typeof Bun.env.KEY>().toEqualTypeOf<typeof process.env.KEY>()`.

## Project Structure

```
├── tokens.toml                              # Single Source of Truth (SSOT) for design tokens
├── scripts/
│   └── generate_tokens.ts                   # Token compiler (TOML -> TS, CSS, HTML)
├── validation/
│   └── token_validator.ts                   # CIEDE2000, WCAG 2.1, and token invariant validators
├── tests/
│   ├── verify_tokens.test.ts                # Token verification (242 table-driven, 350 property-based assertions)
│   ├── server_headers.test.ts               # Header snapshot: no X-Frame-Options, CSP frame-ancestors
│   ├── server_port.test.ts                  # BUN_PORT=4100 cascade verification
│   ├── server_error.test.ts                 # Production error boundary without stack traces
│   ├── env_types.test-d.ts                  # Bun.env vs process.env type parity
│   ├── env_types.test.ts                    # Test runner for env_types
│   ├── bench_server.test.ts                 # Latency benchmarks: Response.json & Bun.file lazy handles
│   ├── sendfile_threshold.test.ts           # 16KB, 64KB, 1MB handle latency vs socket transfer benchmark
│   ├── fetch_timeout.test.ts                # Outbound AbortSignal.timeout enforcement tests
│   ├── fetch_proxy_isolation.test.ts        # NO_PROXY loopback isolation tests
│   └── fetch_url_credentials.test.ts        # Codebase audit: 0 URL credentials, 0 rejectUnauthorized: false
├── domain-branded-types.ts                  # Nominal branded primitives, discriminated unions & tables
├── env.d.ts                                 # Bun.Env & NodeJS.ProcessEnv interface merging
├── sportsdesk_webview_server.ts             # Native Bun HTTP server & Telegram Mini App gateway
├── sportsdesk_cli.ts                        # Surveillance CLI, TrueColor neuron registry (-N), R2 sync
├── simulate_bettor_churn_suite.ts           # 52-week dual-basis bettor churn simulation suite
├── customer-churn-simulation-dashboard.html # Webview executive churn dashboard
├── telegram-miniapp-dashboard.html          # Telegram Mini App (TMA) mobile dashboard
├── sportsdesk_r2_sync.ts                    # Zero-dependency Cloudflare R2 S3 SigV4 sync client
├── sportsdesk_telegram_bot.ts               # Telegram wager alert dispatcher & bot commands
├── reporting_scheduler_service.ts           # 08:00, 13:00, 23:00 EDT scheduled reporting daemon
├── agent_onepass_plugin.ts                  # Single-pass streaming 50% liability portfolio accumulator
├── run_reports.sh                           # 7-report auditable surveillance pipeline
├── deploy_to_vps.sh                         # Production Systemd, Nginx, Let's Encrypt installer
├── token_architecture_and_verification_runbook.md # Detailed token taxonomy and CI mathematics
├── bun_server_runtime_shapes_runbook.md     # Bun HTTP Server, WebSocketHandler & TLSOptions specification
├── cloudflare_r2_and_api_runbook.md         # Cloudflare API & R2 credentials guide
├── os_bun_cron_integration_guide.md         # OS crontab and Bun cron integration guide
└── vps_domain_setup_runbook.md              # Production VPS domain deployment runbook
```

## Documentation Runbooks

- [Bun Server Runtime Shapes Runbook](bun_server_runtime_shapes_runbook.md) — Comprehensive specification of `Server extends Disposable`, `WebSocketHandler<T>`, and `TLSOptions`.
- [Token Architecture & Verification Runbook](token_architecture_and_verification_runbook.md) — Mathematical specification of CIEDE2000, WCAG contrast, and token code generation.
- [Cloudflare R2 & API Runbook](cloudflare_r2_and_api_runbook.md) — Complete Cloudflare API & R2 storage guide.
- [OS Bun Cron Integration Guide](os_bun_cron_integration_guide.md) — OS crontab and systemd timer integration guide.
- [VPS Domain Setup Runbook](vps_domain_setup_runbook.md) — Production VPS deployment guide.
