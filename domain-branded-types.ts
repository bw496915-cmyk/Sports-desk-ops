/**
 * @file domain-branded-types.ts
 * @description Specification-Grade Domain Branded Primitives & Identity Guardrails (Bun v1.4+).
 *
 * Implements the 16 Domain-Specific Branded Types for SportsDesk Operations and Fantasy402:
 *  1.  Cents                - Strict integer cents (Math.round(d * 100)); SQLite storage unit.
 *  2.  Dollars              - Display-boundary float; never used in internal risk math.
 *  3.  CustomerIdentifier   - Trimmed uppercase bettor login without abbreviations.
 *  4.  PaddedCustomerId     - 11-char space-padded canonical ID for Fantasy402 Manager/updateByColumn.
 *  5.  AgentIdentifier      - Direct owning sub-agent identifier (never master BILLY666 on player writes).
 *  6.  TicketIdentifier     - Composite parent key ${login}|${wagerNumber}.
 *  7.  EpochSec             - Monotonic unix seconds integer for time-delta joins and SLA windows.
 *  8.  EpochMs              - Monotonic unix milliseconds for high-resolution latency evaluation.
 *  9.  ColorHexInt          - Single-parse 24-bit RGB packed integer (0x000000..0xFFFFFF) discarding alpha.
 *  10. BetGroupIdentifier   - Cross-book GS Buckeye Partner 118 join key matching /^M\.G\d+$/.
 *  11. ParlayLegCount       - Explicit proposition leg count integer strictly > 1 on GSBUILDER.
 *  12. RotationNumber       - 3-to-6 digit board rotation integer (100..999999).
 *  13. AmericanOdds         - American odds integer validated outside the [-99..+99] deadband.
 *  14. HalfPointLine        - Preserved half-point string with Unicode ½ (\u00BD) hook.
 *  15. SharpScore           - Empirical Bayes shrunk score [0.00..100.00] with N_min=8 shrinkage.
 *  16. BasisPoints          - Integer basis points (100 bps = 1.00%, 10,000 bps = 100%).
 */

// ============================================================================
// 1. BRAND DISCRIMINATOR & UNIVERSAL BRAND ENGINE
// ============================================================================

const __brand = Symbol("brand");

/**
 * Universal nominal branding wrapper attaching compile-time brand discriminator
 * while preserving zero-overhead runtime representation of the base primitive.
 */
export type Brand<BasePrimitive, BrandToken extends string> = BasePrimitive & {
  readonly [__brand]: BrandToken;
};

// ============================================================================
// 2. MONETARY & VALUATION BRANDED PRIMITIVES
// ============================================================================

/**
 * Strict integer cents. Always Math.round() before construction.
 * Used exclusively for SQLite storage, ledger math, and risk accounting.
 */
export type Cents = Brand<number, "Cents">;

export function isCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isInteger(value);
}

export function assertCents(value: unknown): asserts value is Cents {
  if (!isCents(value)) {
    throw new TypeError(`Expected integer Cents primitive, received: ${String(value)}`);
  }
}

export function parseAsCents(dollarsOrCents: number, isAlreadyCents: boolean = true): Cents {
  const normalized = isAlreadyCents
    ? Math.round(dollarsOrCents)
    : Math.round(dollarsOrCents * 100);
  return normalized as Cents;
}

/**
 * Display-boundary decimal dollars.
 * Permitted ONLY at human display surfaces and formatting layers; never in internal risk math.
 */
export type Dollars = Brand<number, "Dollars">;

export function isDollars(value: unknown): value is Dollars {
  return typeof value === "number" && !Number.isNaN(value) && Number.isFinite(value);
}

export function centsToDollars(centsValue: Cents): Dollars {
  assertCents(centsValue);
  return (centsValue / 100) as Dollars;
}

export function formatDollarsString(dollarsValue: Dollars): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollarsValue);
}

// ============================================================================
// 3. IDENTIFIER & DOWNLINE ENTITY BRANDED PRIMITIVES
// ============================================================================

/**
 * Trimmed uppercase customer login identifier (e.g. "RF2003", "BGD101", "MM800").
 */
export type CustomerIdentifier = Brand<string, "CustomerIdentifier">;

// Backward-compatible alias
export type CustomerId = CustomerIdentifier;

export function isCustomerIdentifier(value: unknown): value is CustomerIdentifier {
  return typeof value === "string" && /^[A-Z0-9_\-\.]{2,32}$/.test(value.trim());
}

export function customerIdentifier(rawIdentifier: string): CustomerIdentifier {
  const trimmed = rawIdentifier.trim().toUpperCase();
  if (trimmed.length < 2) {
    throw new TypeError(`CustomerIdentifier cannot be shorter than 2 characters: '${rawIdentifier}'`);
  }
  return trimmed as CustomerIdentifier;
}

/**
 * Space-padded 11-character canonical ID for Fantasy402 Manager/updateByColumn mutations.
 * Enforces exact 11-character invariant to prevent silent non-persisting Result: 0 drops.
 */
export type PaddedCustomerId = Brand<string, "PaddedCustomerId">;

export function isPaddedCustomerId(value: unknown): value is PaddedCustomerId {
  return typeof value === "string" && value.length === 11 && value.trim().length > 0;
}

export function padCustomerIdCanonical(rawIdentifier: string): PaddedCustomerId {
  const trimmed = rawIdentifier.trim().toUpperCase();
  if (trimmed.length === 0 || trimmed.length > 11) {
    throw new RangeError(
      `PaddedCustomerId source length must be between 1 and 11 characters (got ${trimmed.length}): '${rawIdentifier}'`
    );
  }
  return trimmed.padEnd(11, " ") as PaddedCustomerId;
}

/**
 * Direct owning sub-agent identifier (e.g. "CUB22HR", "BIGDAD", "ATEAM").
 */
export type AgentIdentifier = Brand<string, "AgentIdentifier">;

// Backward-compatible alias
export type AgentId = AgentIdentifier;

export function isAgentIdentifier(value: unknown): value is AgentIdentifier {
  return typeof value === "string" && /^[A-Z0-9_\-\.]{2,32}$/.test(value.trim());
}

export function agentIdentifier(rawIdentifier: string): AgentIdentifier {
  const trimmed = rawIdentifier.trim().toUpperCase();
  if (trimmed.length < 2) {
    throw new TypeError(`AgentIdentifier cannot be shorter than 2 characters: '${rawIdentifier}'`);
  }
  return trimmed as AgentIdentifier;
}

/**
 * Composite parent ticket identifier: `${Login.trim()}|${WagerNumber}`.
 */
export type TicketIdentifier = Brand<string, "TicketIdentifier">;

// Backward-compatible alias
export type TicketId = TicketIdentifier;

export function isTicketIdentifier(value: unknown): value is TicketIdentifier {
  return typeof value === "string" && /^[A-Z0-9_\-\.]+\|\d+$/.test(value);
}

export function ticketIdentifier(
  loginIdentifier: string,
  wagerNumberIdentifier: string | number
): TicketIdentifier {
  const cleanLogin = loginIdentifier.trim().toUpperCase();
  const cleanWagerNumber = String(wagerNumberIdentifier).trim();
  if (!cleanLogin || !cleanWagerNumber) {
    throw new TypeError(`TicketIdentifier components cannot be empty: login='${cleanLogin}', wagerNumber='${cleanWagerNumber}'`);
  }
  return `${cleanLogin}|${cleanWagerNumber}` as TicketIdentifier;
}

/**
 * Cross-book GS Buckeye Partner 118 join key from M.G(\d+) header.
 */
export type BetGroupIdentifier = Brand<string, "BetGroupIdentifier">;

// Backward-compatible alias
export type BetGroupId = BetGroupIdentifier;

export function isBetGroupIdentifier(value: unknown): value is BetGroupIdentifier {
  return typeof value === "string" && /^M\.G\d+$/.test(value);
}

export function betGroupIdentifier(raw: string): BetGroupIdentifier {
  const match = raw.match(/M\.G(\d+)/);
  if (!match) {
    throw new TypeError(`Invalid BetGroupIdentifier format (must contain 'M.G<digits>'): '${raw}'`);
  }
  return `M.G${match[1]}` as BetGroupIdentifier;
}

export function extractBetGroupIdentifier(rawDescription: string): BetGroupIdentifier | null {
  const match = rawDescription.match(/M\.G(\d+)/);
  return match ? (`M.G${match[1]}` as BetGroupIdentifier) : null;
}

// ============================================================================
// 4. TEMPORAL & TIMESTAMP BRANDED PRIMITIVES
// ============================================================================

/**
 * Whole seconds Unix epoch timestamp (Math.floor(ms / 1000)).
 * Used for ALERT twin gapDurationSeconds and <=300s Weblog joins.
 */
export type EpochSec = Brand<number, "EpochSec">;

export function isEpochSec(value: unknown): value is EpochSec {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 4102444800; // < Year 2100
}

export function parseAsEpochSec(dateOrMs: number | string | Date): EpochSec {
  if (typeof dateOrMs === "number") {
    const sec = dateOrMs > 10000000000 ? Math.floor(dateOrMs / 1000) : Math.floor(dateOrMs);
    return sec as EpochSec;
  }
  const ms = typeof dateOrMs === "string" ? Date.parse(dateOrMs) : dateOrMs.getTime();
  return Math.floor(ms / 1000) as EpochSec;
}

/**
 * High-precision milliseconds Unix epoch timestamp.
 */
export type EpochMs = Brand<number, "EpochMs">;

export function isEpochMs(value: unknown): value is EpochMs {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseAsEpochMs(dateOrMs: number | string | Date): EpochMs {
  if (typeof dateOrMs === "number") {
    return Math.floor(dateOrMs) as EpochMs;
  }
  const ms = typeof dateOrMs === "string" ? Date.parse(dateOrMs) : dateOrMs.getTime();
  return Math.floor(ms) as EpochMs;
}

// ============================================================================
// 5. COLOR, ANNOTATION & RENDERING BRANDED PRIMITIVES
// ============================================================================

/**
 * Single-parse 24-bit packed RGB integer derived from Bun.color(c, "number") or CSS hex.
 * Strict domain invariant: 0x000000 <= color <= 0xFFFFFF (0..16777215). Alpha is discarded by design.
 */
export type ColorHexInt = Brand<number, "ColorHexInt">;

export function isColorHexInt(value: unknown): value is ColorHexInt {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0x000000 &&
    value <= 0xffffff
  );
}

export function assertColorHexInt(value: unknown): asserts value is ColorHexInt {
  if (!isColorHexInt(value)) {
    throw new RangeError(`ColorHexInt must be a 24-bit integer between 0x000000 and 0xFFFFFF (got: ${String(value)})`);
  }
}

export function parseAsColorHexInt(cssOrNumber: string | number): ColorHexInt {
  if (typeof cssOrNumber === "number") {
    const masked = cssOrNumber > 0xffffff ? (cssOrNumber >>> 8) & 0xffffff : cssOrNumber & 0xffffff;
    return masked as ColorHexInt;
  }

  const clean = cssOrNumber.trim();

  // 1. Primary: Native Bun.color parser (Bun v1.4+)
  if (typeof Bun !== "undefined" && typeof (Bun as any).color === "function") {
    try {
      const parsed = (Bun as any).color(clean, "number");
      if (typeof parsed === "number" && !Number.isNaN(parsed)) {
        // Bun returns 32-bit rgba number; mask down to 24-bit RGB packed integer discarding alpha
        const masked = parsed > 0xffffff ? (parsed >>> 8) & 0xffffff : parsed & 0xffffff;
        return masked as ColorHexInt;
      }
    } catch {
      // Fall through to manual parsing
    }
  }

  // 2. Strict hex parsing fallback
  if (clean.startsWith("#")) {
    const hexDigits = clean.slice(1);
    if (hexDigits.length === 6) {
      return parseInt(hexDigits, 16) as ColorHexInt;
    }
    if (hexDigits.length === 8) {
      return parseInt(hexDigits.slice(0, 6), 16) as ColorHexInt;
    }
    if (hexDigits.length === 3) {
      const expanded = hexDigits.split("").map(ch => ch + ch).join("");
      return parseInt(expanded, 16) as ColorHexInt;
    }
  }

  const fallback = parseInt(clean.replace(/[^0-9a-fA-F]/g, "").slice(0, 6), 16) || 0;
  return fallback as ColorHexInt;
}

export function parseAsColorCssString(cssOrNumber: string | number): string {
  if (typeof Bun !== "undefined" && typeof (Bun as any).color === "function") {
    try {
      const css = (Bun as any).color(cssOrNumber, "css");
      if (typeof css === "string" && css.length > 0) {
        return css;
      }
    } catch {
      // Fallback
    }
  }
  const hexInt = parseAsColorHexInt(cssOrNumber);
  return colorHexIntToHexString(hexInt);
}

export function colorHexIntToRgbChannels(color: ColorHexInt): { readonly red: number; readonly green: number; readonly blue: number } {
  assertColorHexInt(color);
  return {
    red: (color >> 16) & 0xff,
    green: (color >> 8) & 0xff,
    blue: color & 0xff,
  };
}

export function colorHexIntToHexString(color: ColorHexInt): string {
  assertColorHexInt(color);
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function colorHexIntToAnsiEscape(color: ColorHexInt): string {
  const { red, green, blue } = colorHexIntToRgbChannels(color);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

// ============================================================================
// 6. WAGERING, ROTATION & MARKET SPECIFICATION BRANDED PRIMITIVES
// ============================================================================

export type ParlayLegCount = Brand<number, "ParlayLegCount">;

export function isParlayLegCount(value: unknown): value is ParlayLegCount {
  return typeof value === "number" && Number.isInteger(value) && value > 1;
}

export function parlayLegCount(rawCount: number): ParlayLegCount {
  const integerCount = Math.floor(rawCount);
  if (integerCount <= 1) {
    throw new RangeError(`ParlayLegCount must be strictly greater than 1 (got: ${rawCount})`);
  }
  return integerCount as ParlayLegCount;
}

export type RotationNumber = Brand<number, "RotationNumber">;

export function isRotationNumber(value: unknown): value is RotationNumber {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 999999;
}

export function rotationNumber(rawNumber: number | string): RotationNumber {
  const parsed = typeof rawNumber === "string" ? parseInt(rawNumber, 10) : Math.floor(rawNumber);
  if (!isRotationNumber(parsed)) {
    throw new RangeError(`RotationNumber must be an integer between 100 and 999999 (got: ${rawNumber})`);
  }
  return parsed as RotationNumber;
}

export type AmericanOdds = Brand<number, "AmericanOdds">;

export function isAmericanOdds(value: unknown): value is AmericanOdds {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value <= -100 || value >= 100)
  );
}

export function parseAmericanOdds(rawOdds: number | string): AmericanOdds {
  let val: number;
  if (typeof rawOdds === "string") {
    const clean = rawOdds.replace("+", "").trim();
    val = parseInt(clean, 10);
  } else {
    val = Math.floor(rawOdds);
  }

  if (val > -100 && val < 100) {
    throw new RangeError(`AmericanOdds cannot reside in invalid [-99..+99] deadband (got: ${val})`);
  }
  return val as AmericanOdds;
}

export type HalfPointLine = Brand<string, "HalfPointLine">;

export function isHalfPointLine(value: unknown): value is HalfPointLine {
  return typeof value === "string" && value.length > 0;
}

export function formatHalfPointLine(rawLine: string | number): HalfPointLine {
  if (typeof rawLine === "number") {
    const sign = rawLine > 0 ? "+" : "";
    const whole = Math.trunc(rawLine);
    const hasHalf = Math.abs(rawLine % 1) === 0.5;
    if (hasHalf) {
      return `${sign}${whole === 0 && rawLine < 0 ? "-" : whole !== 0 ? whole : ""}\u00BD` as HalfPointLine;
    }
    return `${sign}${rawLine}` as HalfPointLine;
  }

  const normalized = rawLine
    .trim()
    .replace(/\.5\b/g, "\u00BD")
    .replace(/1\/2/g, "\u00BD");
  return normalized as HalfPointLine;
}

export type SharpScore = Brand<number, "SharpScore">;

export function isSharpScore(value: unknown): value is SharpScore {
  return typeof value === "number" && value >= 0 && value <= 100;
}

export function computeBayesSharp(rawScore: number, ticketCount: number): SharpScore {
  const n = Math.max(0, ticketCount);
  const weight = n / (n + 25.0);
  const shrunk = weight * rawScore + (1.0 - weight) * 50.0;
  const bounded = Math.min(100.0, Math.max(0.0, shrunk));
  return Number(bounded.toFixed(2)) as SharpScore;
}

export type BasisPoints = Brand<number, "BasisPoints">;

export function isBasisPoints(value: unknown): value is BasisPoints {
  return typeof value === "number" && Number.isInteger(value);
}

export function parseAsBasisPoints(ratioOrBps: number, isAlreadyBps: boolean = false): BasisPoints {
  const val = isAlreadyBps ? Math.round(ratioOrBps) : Math.round(ratioOrBps * 10000);
  return val as BasisPoints;
}

export function basisPointsToPercentage(bps: BasisPoints): number {
  return bps / 100;
}

// ============================================================================
// 7. QWEN3.5-4B NEURON REGISTRY & DECOUPLED THREE-AXIS SCHEMAS (LAYERS 18-28)
// ============================================================================

export type SignalChannelCode =
  | "Internet"
  | "BLOCKED"
  | "GATEWAY"
  | "ALERT"
  | "GSBUILDER"
  | "GSLIVE"
  | "CSLEVEL2";

export type SignalChannelStatus =
  | "ACTIVE"
  | "DROPPED"
  | "ALERT"
  | "STEERABLE"
  | "CRITICAL"
  | "SUPPRESSED";

export type DecisionMoveFlag =
  | "STEAM_CONVERGENCE"
  | "SHRINKAGE_SHARP"
  | "LIQUIDITY_HALT"
  | "TERMINAL_ENFORCE";

/**
 * Axis 1: Ingestion Signal Channels (Layers 18–24).
 * Strictly typed by physical transport network latency SLA in milliseconds (transportLatencySlaMs: number).
 */
export interface IngestionChannelDefinition {
  readonly layerId: `L${number}.N${string}`;
  readonly tokenName: string;
  readonly hex: string;
  readonly channelCode: SignalChannelCode;
  readonly signalTier: string;
  readonly transportUri: string;
  readonly transportLatencySlaMs: number;
  readonly channelStatus: SignalChannelStatus;
  readonly volumeRule: string;
  readonly operationalRole: string;
}

/**
 * Axis 2: Risk Decision & Route Continuum (Layers 25–28).
 * Strictly typed by algorithmic trigger predicates, move flags, and mitigation enforcement actions.
 */
export interface RouteCircuitDefinition {
  readonly layerId: `L${number}.N${string}`;
  readonly tokenName: string;
  readonly hex: string;
  readonly routeName: string;
  readonly moveFlag: DecisionMoveFlag;
  readonly triggerPredicate: string;
  readonly algorithmicThreshold: string;
  readonly mitigationAction: string;
  readonly operationalRole: string;
}

/**
 * Axis 3: Telemetry Viewports & Rendering Surfaces.
 * Strictly typed by target viewport dimensions, color depth, and display context.
 */
export interface SurfaceDefinition {
  readonly layerId: "SURFACE.DOM" | "SURFACE.CLI";
  readonly tokenName: string;
  readonly hex: string;
  readonly surfaceName: string;
  readonly targetViewport: string;
  readonly colorDepth: string;
  readonly operationalRole: string;
}

export type AnyQwenNeuronDefinition =
  | IngestionChannelDefinition
  | RouteCircuitDefinition
  | SurfaceDefinition;

/**
 * Ingestion Signal Channels (Layers 18-24).
 * Every channel has a strictly typed integer transportLatencySlaMs (milliseconds).
 */
export const INGESTION_CHANNELS: readonly IngestionChannelDefinition[] = [
  {
    layerId: "L18.N0204",
    tokenName: "--sd-tier-retail",
    hex: "#1d84b5",
    channelCode: "Internet",
    signalTier: "SIGNAL_INTERNET",
    transportUri: "portal://ticker/live-stream",
    transportLatencySlaMs: 1500,
    channelStatus: "ACTIVE",
    volumeRule: "TARGET_TWIN (gapDurationSeconds = Internet - ALERT)",
    operationalRole: "Retail Pregame Baseline Gate",
  },
  {
    layerId: "L19.N0518",
    tokenName: "--sd-tier-blocked",
    hex: "#64748b",
    channelCode: "BLOCKED",
    signalTier: "SIGNAL_SENTINEL_DROP",
    transportUri: "portal://pending/noise-filter",
    transportLatencySlaMs: 0,
    channelStatus: "DROPPED",
    volumeRule: "DROP_BEFORE_GROUPING (unconditionally dropped on getPending)",
    operationalRole: "Blocked Sentinel & Zero-Stake Filter",
  },
  {
    layerId: "L20.N1105",
    tokenName: "--sd-theme-emerald",
    hex: "#10b981",
    channelCode: "GATEWAY",
    signalTier: "SIGNAL_EQUILIBRIUM_GATE",
    transportUri: "portal://gateway/equilibrium-gate",
    transportLatencySlaMs: 1000,
    channelStatus: "ACTIVE",
    volumeRule: "EQUILIBRIUM_SWEEP (+15c/+20c vig persist read-backs)",
    operationalRole: "Equilibrium Confirm & Vig Gate",
  },
  {
    layerId: "L21.N0884",
    tokenName: "--sd-tier-alert",
    hex: "#ef4444",
    channelCode: "ALERT",
    signalTier: "SIGNAL_ALERT_TWIN",
    transportUri: "portal://ticker/alert-twins",
    transportLatencySlaMs: 250,
    channelStatus: "ALERT",
    volumeRule: "SOURCE_ALERT (canonicalVolumeCents = 0; skip Bayes scoring)",
    operationalRole: "Syndicate Sub-acct Syntax & Twin Buffer",
  },
  {
    layerId: "L22.N1402",
    tokenName: "--sd-tier-steam",
    hex: "#f59e0b",
    channelCode: "GSBUILDER",
    signalTier: "SIGNAL_SGP_BUILDER",
    transportUri: "portal://ticker/sgp-builder",
    transportLatencySlaMs: 1000,
    channelStatus: "STEERABLE",
    volumeRule: "GS118_JOIN (joined via M.G<betGroupId>; steerable via --steer)",
    operationalRole: "Steam / Line Chase Phrasing & SGP Builder",
  },
  {
    layerId: "L23.N0412",
    tokenName: "--sd-tier-whale",
    hex: "#28a745",
    channelCode: "GSLIVE",
    signalTier: "SIGNAL_GS_INPLAY",
    transportUri: "portal://ticker/gs-partner-118",
    transportLatencySlaMs: 500,
    channelStatus: "CRITICAL",
    volumeRule: "GS118_JOIN (forces rotationGrade='LIVE'; extracts M.G<id>; +20c tax)",
    operationalRole: "Whale Sizing Anomaly & In-Play Live Move",
  },
  {
    layerId: "L24.N2019",
    tokenName: "--sd-tier-rec-bias",
    hex: "#38bdf8",
    channelCode: "CSLEVEL2",
    signalTier: "SIGNAL_SYNDICATE_L2",
    transportUri: "portal://ticker/cslevel2-feed",
    transportLatencySlaMs: 2000,
    channelStatus: "SUPPRESSED",
    volumeRule: "NONE (secondary syndicate/tennis/prop feed; steerable via --steer)",
    operationalRole: "Recreational Longshot Bias Ingestion",
  },
];

/**
 * Decision & Route Continuum (Layers 25-28).
 * L27.N0912 is assigned dedicated #d97706 (Amber-600) to eliminate collision with L22.N1402 (#f59e0b).
 */
export const ROUTE_CIRCUITS: readonly RouteCircuitDefinition[] = [
  {
    layerId: "L25.N1882",
    tokenName: "--sd-route-devig",
    hex: "#06b6d4",
    routeName: "Route 04 Devig Consensus",
    moveFlag: "STEAM_CONVERGENCE",
    triggerPredicate: "Adverse selection vs PINNACLE_REF",
    algorithmicThreshold: "Consensus Lag <= 5,000 ms",
    mitigationAction: "Dynamic Quote Reprice & Spread Realignment",
    operationalRole: "Steam Convergence & Consensus Price Arbitration",
  },
  {
    layerId: "L26.N3104",
    tokenName: "--sd-route-sharp",
    hex: "#a855f7",
    routeName: "Route 02 Sharp Shrinkage",
    moveFlag: "SHRINKAGE_SHARP",
    triggerPredicate: "CLV margin decay across settled wagers",
    algorithmicThreshold: "tau* = 0.68, N_min >= 8 tickets",
    mitigationAction: "Empirical Bayes Score Recalibration & Limit Shading",
    operationalRole: "Bayesian Sharp Detection & Margin Decay Guard",
  },
  {
    layerId: "L27.N0912",
    tokenName: "--sd-route-pending",
    hex: "#d97706",
    routeName: "Route 01 Liquidity Breaker",
    moveFlag: "LIQUIDITY_HALT",
    triggerPredicate: "Order book depth exhaustion during active steam",
    algorithmicThreshold: "Market Depth < $1,000 USD",
    mitigationAction: "Automated Circuit Breaker Trading Halt & Pending Queue Hold",
    operationalRole: "Liquidity Exhaustion Protection & Breaker Trip",
  },
  {
    layerId: "L28.N2501",
    tokenName: "--sd-route-manager",
    hex: "#f43f5e",
    routeName: "Route 03 Manager Terminal",
    moveFlag: "TERMINAL_ENFORCE",
    triggerPredicate: "Terminal downline deficit or toxic syndicate escalation",
    algorithmicThreshold: "Toxicity >= 80 || Hold <= -50% || Deficit > $100k",
    mitigationAction: "Manager/updateByColumn Limit Slash to $1k & Upfront Escrow",
    operationalRole: "Terminal Risk Containment & Manager Write-Gate",
  },
];

/**
 * Telemetry Viewports & Rendering Surfaces.
 */
export const TELEMETRY_SURFACES: readonly SurfaceDefinition[] = [
  {
    layerId: "SURFACE.DOM",
    tokenName: "--sd-surface-bg",
    hex: "#070b14",
    surfaceName: "Dark Obsidian Shell",
    targetViewport: "1440x900 (Desktop) / 375x812 (Mobile)",
    colorDepth: "24-bit TrueColor RGB",
    operationalRole: "Main Dashboard DOM Surface Background",
  },
  {
    layerId: "SURFACE.CLI",
    tokenName: "--sd-surface-cli",
    hex: "#04070e",
    surfaceName: "Deterministic Dark ANSI",
    targetViewport: "Standard VT100 / xterm-256color / ANSI Terminal",
    colorDepth: "24-bit TrueColor RGB",
    operationalRole: "CLI Terminal Telemetry Surface Background",
  },
];

/**
 * Complete 13-entity registry across all 3 decoupled axes.
 */
export const ALL_QWEN_TOKENS: readonly AnyQwenNeuronDefinition[] = [
  ...INGESTION_CHANNELS,
  ...ROUTE_CIRCUITS,
  ...TELEMETRY_SURFACES,
];

/**
 * CI Guardrail: Asserts 1-to-1 uniqueness between CSS tokens, layer IDs, and ColorHexInt values.
 * Throws immediately if duplicate hex codes or tokens are detected across distinct operational entities.
 */
export function assertUniqueTokenColors(
  tokens: readonly { readonly layerId: string; readonly tokenName: string; readonly hex: string }[]
): void {
  const seenHex = new Map<number, string>();
  const seenTokens = new Set<string>();
  const seenLayers = new Set<string>();

  for (const t of tokens) {
    if (seenTokens.has(t.tokenName)) {
      throw new Error(`Duplicate CSS tokenName detected in registry: '${t.tokenName}' (Layer: ${t.layerId})`);
    }
    seenTokens.add(t.tokenName);

    if (seenLayers.has(t.layerId)) {
      throw new Error(`Duplicate layerId detected in registry: '${t.layerId}' (Token: ${t.tokenName})`);
    }
    seenLayers.add(t.layerId);

    const colorInt = parseAsColorHexInt(t.hex);
    if (seenHex.has(colorInt)) {
      const prior = seenHex.get(colorInt)!;
      throw new Error(
        `Color Hex Collision Detected! Color 0x${colorInt.toString(16).padStart(6, "0")} (${t.hex}) is shared between '${prior}' and '${t.tokenName}' (${t.layerId}). Each entity must have a distinct ColorHexInt.`
      );
    }
    seenHex.set(colorInt, `${t.tokenName} (${t.layerId})`);
  }
}

