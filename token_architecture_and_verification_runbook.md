# SportsDesk & Fantasy402 Qwen3.5-4B Token Architecture, Perceptual Color Mathematics & CI Quality Gate Runbook

This runbook defines the architecture, type contracts, mathematical foundations, and automated verification gates for the **Qwen3.5-4B (Layers 18–28) Neuron Design Token Taxonomy** implemented across SportsDesk and Fantasy402 books.

---

## 1. Architectural Principles & Single Source of Truth (SSOT)

Prior to this architecture, design tokens existed as fragmented hand-edited swatches across TypeScript definitions, CSS `:root` blocks, `@property` declarations, and CLI ANSI renderers. This resulted in semantic drift, type leakage (e.g. synthetic `0 ms (Drop)` latencies), and exact hex collisions (`#f59e0b` simultaneously representing Builder Steam and Pending Breaker).

### 1.1 The Single Source of Truth: `tokens.toml`

All 13 design tokens, surface backgrounds, ingestion channel characteristics, and algorithmic routes originate exclusively in `/Users/nolarose/code/sportsdesk-ops/tokens.toml`.

No developer or tool edits the generated token blocks directly. Instead:

```bash
bun run gen:tokens
```

This executes `scripts/generate_tokens.ts`, which parses `tokens.toml` using `Bun.TOML.parse()` and compiles:

1. `domain-branded-types.ts`: Strongly typed nominal branded primitives, discriminated union types, and frozen table arrays (`ALL_QWEN_TOKENS`).
2. `customer-churn-simulation-dashboard.html`: CSS Houdini `@property` registrations, `:root` semantic custom properties, and telemetry badge markup.
3. `telegram-miniapp-dashboard.html`: Mobile-optimized CSS Houdini `@property` registrations and `:root` custom properties.
4. Deterministic formatting via `bun fmt`.

---

## 2. Token Registry & Complete Axis Taxonomy

The taxonomy spans three decoupled axes across Layers 18 through 28:

### 2.1 Surface Tokens

- **`--sd-surface-primary`** (`#070b14` / `0x070b14`): Dark Default Base Surface.
- **`--sd-surface-card`** (`#0b1329` / `0x0b1329`): Dark Secondary Base Surface / Card Elevation.

### 2.2 Axis 1: Ingestion Channels & Transport SLAs

Transport latency is strictly typed via the discriminated union:

```typescript
export type TransportSla =
  | { readonly kind: "latency"; readonly latencySlaMs: number }
  | { readonly kind: "sentinel_drop" };
```

| Layer         | Token Name           | Hex Color | Display Tier              | Status       | Transport SLA                             | Semantics                                             |
| ------------- | -------------------- | --------- | ------------------------- | ------------ | ----------------------------------------- | ----------------------------------------------------- |
| **L18.N0204** | `--sd-tier-retail`   | `#1d84b5` | `SIGNAL_INTERNET`         | `ACTIVE`     | `{ kind: 'latency', latencySlaMs: 1500 }` | Retail pregame baseline flow                          |
| **L19.N0518** | `--sd-tier-blocked`  | `#64748b` | `SIGNAL_SENTINEL_DROP`    | `DROPPED`    | `{ kind: 'sentinel_drop' }`               | Zero-stake / noise sentinel dropped prior to grouping |
| **L20.N1105** | `--sd-gateway-vig`   | `#10b981` | `SIGNAL_EQUILIBRIUM_GATE` | `ACTIVE`     | `{ kind: 'latency', latencySlaMs: 1000 }` | Equilibrium confirm & vig persist gate                |
| **L21.N0884** | `--sd-tier-alert`    | `#ef4444` | `SIGNAL_ALERT_TWIN`       | `ALERT`      | `{ kind: 'latency', latencySlaMs: 250 }`  | Fast syndicate sub-account mirror                     |
| **L22.N1402** | `--sd-tier-steam`    | `#f59e0b` | `SIGNAL_SGP_BUILDER`      | `STEERABLE`  | `{ kind: 'latency', latencySlaMs: 1000 }` | Steam / line chase phrasing (Amber-500)               |
| **L23.N0412** | `--sd-tier-whale`    | `#28a745` | `SIGNAL_GS_INPLAY`        | `CRITICAL`   | `{ kind: 'latency', latencySlaMs: 500 }`  | Live in-play whale sizing anomaly                     |
| **L24.N2019** | `--sd-tier-longshot` | `#38bdf8` | `SIGNAL_SYNDICATE_L2`     | `SUPPRESSED` | `{ kind: 'latency', latencySlaMs: 2000 }` | Recreational longshot bias & secondary feed           |

_Note on Single Ownership_: `#f59e0b` (Amber-500) is strictly exclusive to `L22.N1402`.

### 2.3 Axis 2: Algorithmic Routes & Mitigation Gates

Route thresholds are strictly typed via the discriminated union:

```typescript
export type RouteThreshold =
  | { readonly kind: "consensus_lag"; readonly maxConsensusLagMs: number }
  | {
      readonly kind: "bayes_shrinkage";
      readonly tauStar: number;
      readonly minTicketCount: number;
    }
  | { readonly kind: "liquidity_depth"; readonly minTopDepthCents: Cents }
  | {
      readonly kind: "composite_risk_gate";
      readonly minToxicityScore: number;
      readonly maxHoldPercentage: number;
      readonly maxDeficitCents: Cents;
    };

export enum TriggerPredicateKind {
  CONSENSUS_LAG_EXCEEDED = "CONSENSUS_LAG_EXCEEDED",
  SHARP_POSTERIOR_THRESHOLD = "SHARP_POSTERIOR_THRESHOLD",
  LIQUIDITY_DEPTH_BREACH = "LIQUIDITY_DEPTH_BREACH",
  COMPOSITE_TOXICITY_GATE = "COMPOSITE_TOXICITY_GATE",
}

export enum MitigationActionKind {
  DEVIG_MARKET_EXPANSION = "DEVIG_MARKET_EXPANSION",
  DYNAMIC_JUICE_SHADING = "DYNAMIC_JUICE_SHADING",
  HALT_PENDING_EXPOSURE = "HALT_PENDING_EXPOSURE",
  CLAMP_CUSTOMER_LIMITS = "CLAMP_CUSTOMER_LIMITS",
}
```

| Layer         | Token Name           | Hex Color | Route ID | Route Name              | Threshold Specification                                                                                      | Trigger Predicate           | Mitigation Action        |
| ------------- | -------------------- | --------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------ |
| **L25.N1882** | `--sd-route-devig`   | `#06b6d4` | Route 02 | Adverse Selection Devig | `{ kind: 'consensus_lag', maxConsensusLagMs: 5000 }`                                                         | `CONSENSUS_LAG_EXCEEDED`    | `DEVIG_MARKET_EXPANSION` |
| **L26.N3104** | `--sd-route-sharp`   | `#a855f7` | Route 03 | CLV Margin Decay Sharp  | `{ kind: 'bayes_shrinkage', tauStar: 0.68, minTicketCount: 8 }`                                              | `SHARP_POSTERIOR_THRESHOLD` | `DYNAMIC_JUICE_SHADING`  |
| **L27.N0912** | `--sd-route-pending` | `#d97706` | Route 01 | Liquidity Breaker       | `{ kind: 'liquidity_depth', minTopDepthCents: 100000 }`                                                      | `LIQUIDITY_DEPTH_BREACH`    | `HALT_PENDING_EXPOSURE`  |
| **L28.N2501** | `--sd-route-manager` | `#f43f5e` | Route 04 | Terminal Risk Clamp     | `{ kind: 'composite_risk_gate', minToxicityScore: 80, maxHoldPercentage: -50.0, maxDeficitCents: 10000000 }` | `COMPOSITE_TOXICITY_GATE`   | `CLAMP_CUSTOMER_LIMITS`  |

_Note on Single Ownership_: `#d97706` (Amber-600) is dedicated to `L27.N0912`, eliminating the previous collision with `L22.N1402`.

### 2.4 Axis 3: Terminal Viewport & Rendering Contracts

- **Target Viewport**: `DirectColor VT (Ghostty / xterm-direct)`.
- **Color Depth**: `24-bit TrueColor RGB` via standard ANSI escape sequences: `\x1b[38;2;<R>;<G>;<B>m`.
- **CLI Rendering**: Executable via `bun sportsdesk_cli.ts -N` or `bun sportsdesk_cli.ts --neurons`.

---

## 3. Mathematical Foundations of Perceptual Separation & Contrast

Token validation (`validation/token_validator.ts`) enforces strict metric space and photometric invariants across the palette.

### 3.1 CIEDE2000 Color Difference ($\Delta E_{00}$)

Simple Euclidean RGB distance ($\Delta RGB$) does not model human color perception. The system converts sRGB coordinates to CIE $L^*a^_b^_$ using the standard D65 illuminant, then evaluates CIEDE2000 ($\Delta E_{00}$):

$$\Delta E_{00} = \sqrt{\left(\frac{\Delta L'}{k_L S_L}\right)^2 + \left(\frac{\Delta C'}{k_C S_C}\right)^2 + \left(\frac{\Delta H'}{k_H S_H}\right)^2 + R_T \left(\frac{\Delta C'}{k_C S_C}\right) \left(\frac{\Delta H'}{k_H S_H}\right)}$$

Where:

- $k_L = k_C = k_H = 1$ (standard reference conditions).
- $S_L, S_C, S_H$ are weighting functions for lightness, chroma, and hue.
- $R_T$ is the interactive rotation term accounting for the ellipse tilt in the blue region ($275^\circ$).

#### Perceptual Separation Floor ($\Delta E_{00} \ge 7.0$)

The validation suite enforces $\Delta E_{00} \ge 7.0$ across all distinct pairs. Three borderline pairs in the $7.0 \le \Delta E_{00} < 10.0$ range are verified and documented:

1. **Alert (`#ef4444`, Red-500) vs Manager Route (`#f43f5e`, Rose-500)**: $\Delta E_{00} \approx 7.21$.
   _Justification_: Both represent severe operational risk (Syndicate Alert vs Terminal Limit Clamp), belonging to the red/rose alert continuum while remaining distinguishable.
2. **Steam (`#f59e0b`, Amber-500) vs Pending Breaker (`#d97706`, Amber-600)**: $\Delta E_{00} \approx 7.96$.
   _Justification_: Both signify liquidity stress. The darker Amber-600 signals the circuit breaker halt state.
3. **Devig Route (`#06b6d4`, Cyan-500) vs Recreational Bias (`#38bdf8`, Sky-400)**: $\Delta E_{00} \approx 9.77$.
   _Justification_: Devig represents mathematical balance; sky blue represents recreational market flow.

### 3.2 WCAG 2.1 Contrast Ratio

Relative luminance ($L$) is calculated according to the sRGB IEC 61966-2-1 specification:

$$R_{\text{linear}} = \begin{cases} \frac{R_{\text{sRGB}}}{12.92} & R_{\text{sRGB}} \le 0.04045 \\ \left(\frac{R_{\text{sRGB}} + 0.055}{1.055}\right)^{2.4} & R_{\text{sRGB}} > 0.04045 \end{cases}$$

$$L = 0.2126 \cdot R_{\text{linear}} + 0.7152 \cdot G_{\text{linear}} + 0.0722 \cdot B_{\text{linear}}$$

The contrast ratio between foreground ($L_1$) and background surface ($L_2$) is:

$$\text{Contrast Ratio} = \frac{L_1 + 0.05}{L_2 + 0.05} \quad (\text{where } L_1 \ge L_2)$$

#### Standards Enforced:

- Graphical UI Components & Badges: $\ge 3.0:1$ against `--sd-surface-primary` (`#070b14`) and `--sd-surface-card` (`#0b1329`).
- Body Typography: $\ge 4.5:1$ against base surfaces.

---

## 4. Verification Suite & CI Gates

The verification pipeline is located in `tests/verify_tokens.test.ts` and runs under native Bun:

```bash
bun test tests/verify_tokens.test.ts
```

### 4.1 Test Suites Executed (13 Suites, 592 Assertions)

1. **Zero Drift Test**: Parses `tokens.toml`, `domain-branded-types.ts`, `customer-churn-simulation-dashboard.html`, and `telegram-miniapp-dashboard.html`, asserting identical token counts, variable names, and hex values.
2. **24-bit Exact Uniqueness**: Asserts that all 13 tokens possess unique `ColorHexInt` integers derived from `Bun.color()`.
3. **Perceptual Distance Floor**: Computes pairwise CIEDE2000 distance for all $\binom{13}{2} = 78$ pairs and asserts $\Delta E_{00} \ge 7.0$.
4. **WCAG 2.1 Contrast Gate**: Asserts contrast ratios $\ge 3.0:1$ for UI badges and $\ge 4.5:1$ for text elements against both dark surfaces.
5. **Transport SLA Discrimination**: Confirms that every Axis 1 channel adheres to the `{ kind: 'latency' }` or `{ kind: 'sentinel_drop' }` contract.
6. **Route Threshold Discrimination**: Confirms that every Axis 2 route defines a valid `RouteThreshold` structure with corresponding `TriggerPredicateKind` and `MitigationActionKind`.
7. **Dead Token Detection**: Asserts that every `--sd-*` property declared in `:root` is referenced in the stylesheet, and every referenced token is declared.
8. **Mathematical Property Tests**: Uses generative random color generators to verify metric space axioms for CIEDE2000:
   - Identity of indiscernibles: $\Delta E_{00}(c, c) = 0$.
   - Non-negativity: $\Delta E_{00}(c_1, c_2) \ge 0$.
   - Symmetry: $\Delta E_{00}(c_1, c_2) = \Delta E_{00}(c_2, c_1)$.
   - Contrast monotonicity and bounds: $1.0 \le \text{Contrast} \le 21.0$.

### 4.2 Zero-Drift CI Check

To ensure generated files never drift in Git:

```bash
bun run gen:tokens
git diff --exit-code
```

An exit code of `0` guarantees complete synchronization across all artifacts.
