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
