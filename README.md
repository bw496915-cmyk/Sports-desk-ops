# SportsDesk & Fantasy402 Operations Suite

Production intelligence, downline risk surveillance, Cloudflare R2 backup, Qwen3.5-4B neuron token taxonomy, and automated reporting pipeline built on the **Bun runtime (v1.4+)** for SportsDesk and Fantasy402 books.

Repository: [bw496915-cmyk/Sports-desk-ops](https://github.com/bw496915-cmyk/Sports-desk-ops.git)

---

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

# 5. Run 24h sniper surveillance
bun run sportsdesk_cli.ts winners -p 24h --limit 25

# 6. Generate all 7 auditable surveillance reports
./run_reports.sh --format table

# 7. Run 52-week bettor churn simulation
bun run simulate_bettor_churn_suite.ts
```

---

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

---

## Verification & CI Quality Gates

All tokens and contracts are verified continuously through `validation/token_validator.ts` and `tests/verify_tokens.test.ts`:

1. **Zero Drift**: `bun run gen:tokens && git diff --exit-code` guarantees that `tokens.toml`, `domain-branded-types.ts`, `customer-churn-simulation-dashboard.html`, and `telegram-miniapp-dashboard.html` remain perfectly synchronized.
2. **24-bit Exact Uniqueness**: 13 unique `ColorHexInt` values derived from `Bun.color()`.
3. **CIEDE2000 Perceptual Separation ($\Delta E\_{00} \ge 7.0$)**: Mathematically verified color distance floor across all token pairs, preventing indistinguishable UI swatches.
4. **WCAG 2.1 Contrast Standards**: $\ge 3.0:1$ for graphical UI badges against dark surfaces (`#070b14` / `#0b1329`) and $\ge 4.5:1$ for typography.
5. **Zero Dead Tokens**: Asserts bidirectional reference consistency (all declared tokens used, all used tokens declared).

---

## Project Structure

```
├── tokens.toml                              # Single Source of Truth (SSOT) for design tokens
├── scripts/
│   └── generate_tokens.ts                   # Token compiler (TOML -> TS, CSS, HTML)
├── validation/
│   └── token_validator.ts                   # CIEDE2000, WCAG 2.1, and token invariant validators
├── tests/
│   └── verify_tokens.test.ts                # 13 test suites (592 assertions) for token verification
├── domain-branded-types.ts                  # Nominal branded primitives, discriminated unions & tables
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
├── cloudflare_r2_and_api_runbook.md         # Cloudflare API & R2 credentials guide
├── os_bun_cron_integration_guide.md         # OS crontab and Bun cron integration guide
└── vps_domain_setup_runbook.md              # Production VPS domain deployment runbook
```

---

## Documentation Runbooks

- [Token Architecture & Verification Runbook](token_architecture_and_verification_runbook.md) — Mathematical specification of CIEDE2000, WCAG contrast, and token code generation.
- [Cloudflare R2 & API Runbook](cloudflare_r2_and_api_runbook.md) — Complete Cloudflare API & R2 storage guide.
- [OS Bun Cron Integration Guide](os_bun_cron_integration_guide.md) — OS crontab and systemd timer integration guide.
- [VPS Domain Setup Runbook](vps_domain_setup_runbook.md) — Production VPS deployment guide.
