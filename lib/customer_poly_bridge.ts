/**
 * @file lib/customer_poly_bridge.ts
 * @description Cross-domain value bridge between the SportsDesk/F402 customer book and
 *              Polymarket wallets.
 *
 * There are three joins here, in increasing strength of evidence:
 *
 *   1. ATTRIBUTION — `customerId -> 0x proxy wallet`. Static registry plus the typed
 *      IP/CTF cluster attributions from the layoff-risk scenario. Invalid addresses are
 *      quarantined, never queried.
 *   2. VALUE — the customer's desk P/L vs the wallet's Polymarket P/L. Observational only:
 *      a customer who loses at the desk and wins on Polymarket is a *lead*, not proof of a
 *      hedge or of leakage.
 *   3. LEG — F402 ticket legs vs Polymarket combo legs on the same game/market, with side
 *      relation (MIRROR / OPPOSITE) and line delta. This one is canonical and needs the
 *      SQLite observation store.
 *
 * Evidence tiers: `LIVE` when Polymarket was fetched, `FIXTURE` when the bundled book and
 * static attributions are the only sources, `MIXED` when both are present.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { sqlInt, sqlIntOrNull } from "./sportsdesk_sqlite.ts";
import { evaluateBetterVenue } from "./layoff_risk_engine.ts";
import type { LineHundredths } from "./combo_identity.ts";
import {
  profilePolymarketAddress,
  type AddressProfile,
  type ProfileFetchOptions,
} from "./polymarket_profile.ts";
import { CUSTOMER_TO_POLY_WALLET } from "./parlay_combo_backtest_engine.ts";

export const BRIDGE_SCHEMA_VERSION = 1;
export const DEFAULT_CUSTOMER_BOOK_PATH = "enriched_customers_full.json";
const WALLET_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export type EvidenceTier = "LIVE" | "FIXTURE" | "MIXED";

export type WalletQuarantineReason =
  "EMPTY" | "BAD_PREFIX" | "BAD_LENGTH" | "NON_HEX";

export type CrossVenueVerdict =
  "BOTH_UP" | "POLY_ONLY_UP" | "DESK_ONLY_UP" | "BOTH_DOWN" | "FLAT";

// ============================================================================
// 1. WALLET VALIDATION
// ============================================================================

export type WalletValidation =
  | { readonly valid: true; readonly address: string }
  | {
      readonly valid: false;
      readonly address: string;
      readonly reason: WalletQuarantineReason;
    };

/** Validates and lowercases a 42-char `0x` address. Placeholders never reach the network. */
export function validateWalletAddress(raw: string): WalletValidation {
  const trimmed = raw.trim();
  if (trimmed === "")
    return { valid: false, address: trimmed, reason: "EMPTY" };
  if (!trimmed.toLowerCase().startsWith("0x")) {
    return { valid: false, address: trimmed, reason: "BAD_PREFIX" };
  }
  if (trimmed.length !== 42) {
    return { valid: false, address: trimmed, reason: "BAD_LENGTH" };
  }
  if (!WALLET_PATTERN.test(trimmed)) {
    return { valid: false, address: trimmed, reason: "NON_HEX" };
  }
  return { valid: true, address: trimmed.toLowerCase() };
}

// ============================================================================
// 2. ATTRIBUTION REGISTRY
// ============================================================================

export interface AttributionInput {
  readonly proxyWallet: string;
  readonly customerId: string;
  readonly agentOwner?: string;
  readonly attributionType?: string;
  readonly confidenceBps?: number;
}

export interface AttributionLink {
  readonly customerId: string;
  readonly wallet: string;
  readonly agentOwner: string;
  readonly attributionType: string;
  readonly confidenceBps: number;
}

export interface QuarantinedWallet {
  readonly customerId: string;
  readonly wallet: string;
  readonly reason: WalletQuarantineReason;
}

/**
 * Typed attributions mirrored from the `sportsdesk_layoff_risk_cli.ts` dashboard seed.
 * Two entries (`CB112_1`, `RF2003`) deliberately keep their short placeholder wallets so the
 * bridge can demonstrate quarantine instead of silently dropping them.
 */
export const TYPED_WALLET_ATTRIBUTIONS: readonly AttributionInput[] = [
  {
    proxyWallet: "0x3af8392189d021cfa82",
    customerId: "CB112_1",
    agentOwner: "CUB22HR",
    attributionType: "IP_CLUSTER_OR_SYNDICATE",
    confidenceBps: 9000,
  },
  {
    proxyWallet: "0x3af8771189d099bf71",
    customerId: "RF2003",
    agentOwner: "BILLY666",
    attributionType: "TOUT_BURST_CLUSTER",
    confidenceBps: 6000,
  },
  {
    proxyWallet: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
    customerId: "BGD101",
    agentOwner: "BIGDAD",
    attributionType: "WHALE_CTF_BRIDGE",
    confidenceBps: 10000,
  },
  {
    proxyWallet: "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
    customerId: "MJ102",
    agentOwner: "MJ2026",
    attributionType: "WHALE_CTF_BRIDGE",
    confidenceBps: 10000,
  },
  {
    proxyWallet: "0x120640a1deffe6b53e291eba74acf1dbe8274528",
    customerId: "GP300",
    agentOwner: "GPRO50RSK",
    attributionType: "STEAM_ORIGINATOR_CTF",
    confidenceBps: 10000,
  },
  {
    proxyWallet: "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
    customerId: "AT10359",
    agentOwner: "ATEAM",
    attributionType: "STEAM_ORIGINATOR_CTF",
    confidenceBps: 10000,
  },
  {
    proxyWallet: "0x22e29a644a9d14564967b3f9f50346b7ad425c32",
    customerId: "ABC700",
    agentOwner: "JUICEPLUS",
    attributionType: "NBA_SGP_SHARP",
    confidenceBps: 10000,
  },
  {
    proxyWallet: "0x231699490d08919d8f1d3f0b90fd2a677e3e9819",
    customerId: "DAN245",
    agentOwner: "DAN318",
    attributionType: "NBA_SGP_SHARP",
    confidenceBps: 10000,
  },
  {
    proxyWallet: "0x50cc8708aff3791f2d6125645c82bda532baa534",
    customerId: "EJ8834",
    agentOwner: "MJ2026",
    attributionType: "SUBNET_104_28_34_CLUSTER",
    confidenceBps: 9000,
  },
  {
    proxyWallet: "0xaa7789219c17e180dcb5933099c90d885f1d15a5",
    customerId: "DA4401",
    agentOwner: "JUICEPLUS",
    attributionType: "NBA_TOTAL_MIDDLE",
    confidenceBps: 9000,
  },
];

export interface AttributionRegistry {
  readonly links: readonly AttributionLink[];
  readonly byCustomer: ReadonlyMap<string, readonly AttributionLink[]>;
  readonly byWallet: ReadonlyMap<string, readonly AttributionLink[]>;
  readonly quarantined: readonly QuarantinedWallet[];
  readonly stats: {
    readonly input: number;
    readonly valid: number;
    readonly invalid: number;
    readonly customers: number;
    readonly wallets: number;
    readonly multiWalletCustomers: number;
    readonly sharedWallets: number;
  };
}

function mergeAttribution(
  base: AttributionInput,
  overlay: AttributionInput,
): AttributionInput {
  const agentOwner = overlay.agentOwner ?? base.agentOwner;
  const attributionType = overlay.attributionType ?? base.attributionType;
  const confidenceBps = overlay.confidenceBps ?? base.confidenceBps;
  return {
    proxyWallet: overlay.proxyWallet,
    customerId: overlay.customerId,
    ...(agentOwner === undefined ? {} : { agentOwner }),
    ...(attributionType === undefined ? {} : { attributionType }),
    ...(confidenceBps === undefined ? {} : { confidenceBps }),
  };
}

/**
 * Builds the `customerId <-> wallet` registry from the unverified engine map plus the typed
 * attribution list. Typed entries win; untyped map entries are marked `WALLET_MAP_UNVERIFIED`
 * at 50% confidence and still need operator review.
 */
export function buildAttributionRegistry(
  typed: readonly AttributionInput[] = TYPED_WALLET_ATTRIBUTIONS,
  options?: { readonly includeEngineMap?: boolean },
): AttributionRegistry {
  const merged = new Map<string, AttributionInput>();
  const keyOf = (input: AttributionInput): string =>
    `${input.customerId.trim().toUpperCase()}|${input.proxyWallet.trim().toLowerCase()}`;

  if (options?.includeEngineMap !== false) {
    for (const [customerId, wallet] of Object.entries(
      CUSTOMER_TO_POLY_WALLET,
    )) {
      const base: AttributionInput = {
        proxyWallet: wallet,
        customerId,
        agentOwner: "UNATTRIBUTED",
        attributionType: "WALLET_MAP_UNVERIFIED",
        confidenceBps: 5000,
      };
      merged.set(keyOf(base), base);
    }
  }
  for (const entry of typed) {
    const key = keyOf(entry);
    merged.set(key, mergeAttribution(merged.get(key) ?? entry, entry));
  }

  const links: AttributionLink[] = [];
  const quarantined: QuarantinedWallet[] = [];
  for (const input of merged.values()) {
    const customerId = input.customerId.trim().toUpperCase();
    if (customerId === "") continue;
    const validation = validateWalletAddress(input.proxyWallet);
    if (!validation.valid) {
      quarantined.push({
        customerId,
        wallet: validation.address,
        reason: validation.reason,
      });
      continue;
    }
    links.push({
      customerId,
      wallet: validation.address,
      agentOwner: (input.agentOwner ?? "UNATTRIBUTED").trim().toUpperCase(),
      attributionType: input.attributionType ?? "WALLET_MAP_UNVERIFIED",
      confidenceBps: clampBps(input.confidenceBps ?? 5000),
    });
  }
  links.sort((a, b) => a.customerId.localeCompare(b.customerId));

  const byCustomer = new Map<string, AttributionLink[]>();
  const byWallet = new Map<string, AttributionLink[]>();
  for (const link of links) {
    pushTo(byCustomer, link.customerId, link);
    pushTo(byWallet, link.wallet, link);
  }

  return {
    links,
    byCustomer,
    byWallet,
    quarantined,
    stats: {
      input: merged.size,
      valid: links.length,
      invalid: quarantined.length,
      customers: byCustomer.size,
      wallets: byWallet.size,
      multiWalletCustomers: [...byCustomer.values()].filter(
        (list) => list.length > 1,
      ).length,
      sharedWallets: [...byWallet.values()].filter((list) => list.length > 1)
        .length,
    },
  };
}

function pushTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

function clampBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10_000, Math.max(0, Math.round(value)));
}

// ============================================================================
// 3. CUSTOMER BOOK
// ============================================================================

export interface CustomerBookRow {
  readonly customerId: string;
  readonly agentId: string;
  readonly contextType: string;
  readonly status: string;
  readonly lifetimeVolumeUsd: number;
  readonly lifetimeNetUsd: number;
  readonly sports7dVolumeUsd: number;
  readonly sports7dNetUsd: number;
  readonly clvBps: number;
  readonly sharpScore: number;
  readonly churnHazard: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function text(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

/** Normalizes one `enriched_customers_full.json` row; returns `null` for unusable rows. */
export function normalizeCustomerBookRow(raw: unknown): CustomerBookRow | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const customerId = text(record.customer_id).toUpperCase();
  if (customerId === "") return null;
  return {
    customerId,
    agentId: text(record.agent_id).toUpperCase(),
    contextType: text(record.context_type),
    status: text(record.status),
    lifetimeVolumeUsd: num(record.lifetime_volume_usd),
    lifetimeNetUsd: num(record.lifetime_net_usd),
    sports7dVolumeUsd: num(record.sports_7d_volume_usd),
    sports7dNetUsd: num(record.sports_7d_net_usd),
    clvBps: num(record.clv_bps),
    sharpScore: num(record.sharp_score),
    churnHazard: num(record.churn_hazard),
  };
}

/** Loads the bundled customer book. A missing file yields an empty book, never a throw. */
export async function loadCustomerBook(
  path: string = DEFAULT_CUSTOMER_BOOK_PATH,
): Promise<CustomerBookRow[]> {
  if (!existsSync(path)) return [];
  const parsed: unknown = await Bun.file(path).json();
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(normalizeCustomerBookRow)
    .filter((row): row is CustomerBookRow => row !== null);
}

// ============================================================================
// 4. POLYMARKET OBSERVATION
// ============================================================================

export type PolyValueKind = "SIGNAL" | "LIQUIDITY" | "MIXED" | "UNKNOWN";

export interface PolyObservation {
  readonly address: string;
  readonly name: string | null;
  readonly pnlAllUsd: number | null;
  readonly pnl7dUsd: number | null;
  readonly pnl30dUsd: number | null;
  /** Fee-aware cashflow PnL; `null` when pagination was truncated. */
  readonly cashflowPnlUsd: number | null;
  readonly pnlGapUsd: number | null;
  readonly pnlGapPct: number | null;
  readonly feeResidualUsd: number | null;
  readonly pnlComplete: boolean;
  readonly tradeVolumeUsd: number;
  readonly positions: number;
  readonly openCount: number;
  readonly openValueUsd: number;
  readonly investedUsd: number;
  readonly winRate: number | null;
  readonly winRateEstimated: boolean;
  readonly strategy: string;
  readonly valueKind: PolyValueKind;
  readonly comboSharePct: number | null;
  readonly topCategories: readonly string[];
  readonly pagesFetched: number;
  readonly activityTruncated: boolean;
}

export interface PolyObservationOptions extends ProfileFetchOptions {
  readonly maxActivityPages?: number;
  readonly maxCategoryLookups?: number;
}

/** Projects a full `AddressProfile` down to the fields the bridge scores on. */
export function observationFromProfile(
  profile: AddressProfile,
): PolyObservation {
  const activity = profile.activity;
  const liquidityShare =
    activity.tradeVolume > 0
      ? (activity.splitVolume + activity.mergeVolume) / activity.tradeVolume
      : 0;
  const isLiquidity =
    profile.strategy.name === "SPLIT Arbitrage" ||
    profile.strategy.name === "Market Maker";
  const valueKind: PolyValueKind =
    isLiquidity || liquidityShare > 0.5
      ? "LIQUIDITY"
      : activity.tradeBuys + activity.tradeSells > 0
        ? liquidityShare > 0.1
          ? "MIXED"
          : "SIGNAL"
        : "UNKNOWN";
  return {
    address: profile.address.toLowerCase(),
    name: profile.name,
    pnlAllUsd: profile.pnl.all,
    pnl7dUsd: profile.pnl.d7,
    pnl30dUsd: profile.pnl.d30,
    cashflowPnlUsd: profile.pnlAudit.cashflowPnlUsd,
    pnlGapUsd: profile.pnlAudit.gapUsd,
    pnlGapPct: profile.pnlAudit.gapPct,
    feeResidualUsd: profile.pnlAudit.feeResidualUsd,
    pnlComplete: profile.pnlAudit.complete,
    tradeVolumeUsd: round2(activity.tradeVolume),
    positions: profile.positions.length,
    openCount: profile.openCount,
    openValueUsd: round2(profile.portfolioValueUsd),
    investedUsd: round2(profile.investedUsd),
    winRate: profile.winRate,
    winRateEstimated: profile.winRateEstimated,
    strategy: profile.strategy.name,
    valueKind,
    comboSharePct:
      activity.tradeVolume > 0
        ? round2((activity.comboTradeVolume / activity.tradeVolume) * 100)
        : null,
    topCategories: profile.categories
      .slice(0, 3)
      .map((bucket) => bucket.category),
    pagesFetched: profile.pagesFetched,
    activityTruncated: profile.activityTruncated,
  };
}

/** Fetches one wallet's public profile. Returns `null` for an invalid address. */
export async function observePolymarketWallet(
  address: string,
  options?: PolyObservationOptions,
): Promise<PolyObservation | null> {
  const validation = validateWalletAddress(address);
  if (!validation.valid) return null;
  const profile = await profilePolymarketAddress(validation.address, {
    ...(options?.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
    ...(options?.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options?.lbBase === undefined ? {} : { lbBase: options.lbBase }),
    ...(options?.dataBase === undefined ? {} : { dataBase: options.dataBase }),
    ...(options?.gammaBase === undefined
      ? {}
      : { gammaBase: options.gammaBase }),
    maxActivityPages: options?.maxActivityPages ?? 2,
    maxCategoryLookups: options?.maxCategoryLookups ?? 10,
  });
  return profile === null ? null : observationFromProfile(profile);
}

// ============================================================================
// 5. CROSS-VENUE VALUE
// ============================================================================

export interface CustomerPolyValueRow {
  readonly customerId: string;
  readonly agentId: string;
  readonly contextType: string;
  readonly status: string;
  readonly wallet: string;
  readonly attributionType: string;
  readonly confidenceBps: number;
  /**
   * Customer P/L at the desk. `[ASSUMPTION]`: the bundled book stores the desk's net (negative =
   * desk lost), so the customer's P/L is its negation. Verify against F402 before trusting it.
   */
  readonly customerDeskPnlUsd: number;
  readonly deskVolumeUsd: number;
  /** Desk perspective (`lifetimeNetUsd / lifetimeVolumeUsd`), not the fixture's `hold_pct`. */
  readonly deskHoldPct: number | null;
  readonly clvBps: number;
  readonly sharpScore: number;
  readonly poly: PolyObservation | null;
  /** Fee-aware PnL when activity pagination completed; otherwise the official pre-fee number. */
  readonly polyBasisPnlUsd: number | null;
  readonly pnlBasis: "NET" | "GROSS" | null;
  readonly feeResidualUsd: number | null;
  readonly valueKind: PolyValueKind | null;
  /** Customer's Polymarket P/L minus their desk P/L. Observational, not causal. */
  readonly polyAdvantageUsd: number | null;
  readonly verdict: CrossVenueVerdict | null;
  /** `polyAdvantageUsd` when positive, weighted by attribution confidence. Ranking only. */
  readonly priorityUsd: number;
}

export interface CustomerPolyBridgeReport {
  readonly schemaVersion: 1;
  readonly generatedAtIso: string;
  readonly evidence: EvidenceTier;
  readonly coverage: {
    readonly customersInBook: number;
    readonly linkedCustomers: number;
    readonly linkYieldPct: number;
    readonly wallets: number;
    readonly observedWallets: number;
    readonly invalidWallets: number;
    readonly multiWalletCustomers: number;
    readonly sharedWallets: number;
    readonly attributionTypes: Readonly<Record<string, number>>;
  };
  readonly value: {
    readonly customersWithPoly: number;
    readonly customersWithPnl: number;
    readonly bothUp: number;
    readonly polyOnlyUp: number;
    readonly deskOnlyUp: number;
    readonly bothDown: number;
    readonly flat: number;
    readonly deskVolumeUsd: number;
    readonly customerDeskPnlUsd: number;
    readonly deskHoldPct: number | null;
    readonly polyPnlUsd: number;
    readonly polyGrossPnlUsd: number;
    readonly polyNetPnlUsd: number;
    readonly polyFeeResidualUsd: number;
    readonly netCoveragePct: number;
    readonly polyVolumeUsd: number;
    readonly polyAdvantageUsd: number;
    readonly priorityUsd: number;
    /** Rows whose wallet is attributed to more than one customer; excluded from advantage totals. */
    readonly sharedWalletRows: number;
  };
  readonly customers: readonly CustomerPolyValueRow[];
  readonly quarantined: readonly QuarantinedWallet[];
  readonly notes: readonly string[];
}

export interface BuildCustomerPolyBridgeInput {
  readonly customers: readonly CustomerBookRow[];
  readonly registry: AttributionRegistry;
  readonly observations?: ReadonlyMap<string, PolyObservation>;
  readonly now?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function verdictOf(
  customerDeskPnl: number,
  polyPnl: number,
): CrossVenueVerdict {
  const flat = 1;
  const deskUp = customerDeskPnl > flat;
  const deskDown = customerDeskPnl < -flat;
  const polyUp = polyPnl > flat;
  const polyDown = polyPnl < -flat;
  if (deskUp && polyUp) return "BOTH_UP";
  if (polyUp && deskDown) return "POLY_ONLY_UP";
  if (deskUp && polyDown) return "DESK_ONLY_UP";
  if (deskDown && polyDown) return "BOTH_DOWN";
  return "FLAT";
}

/**
 * Joins the customer book to Polymarket observations through the attribution registry.
 * A customer with several linked wallets gets one row per wallet so links stay auditable.
 */
export function buildCustomerPolyBridge(
  input: BuildCustomerPolyBridgeInput,
): CustomerPolyBridgeReport {
  const observations = input.observations ?? new Map<string, PolyObservation>();
  const customers = new Map(
    input.customers.map((row) => [row.customerId, row] as const),
  );
  const rows: CustomerPolyValueRow[] = [];

  for (const link of input.registry.links) {
    const customer = customers.get(link.customerId);
    if (customer === undefined) continue;
    const poly = observations.get(link.wallet) ?? null;
    const customerDeskPnlUsd = round2(-customer.lifetimeNetUsd);
    const deskHoldPct =
      customer.lifetimeVolumeUsd > 0
        ? round2((customer.lifetimeNetUsd / customer.lifetimeVolumeUsd) * 100)
        : null;
    const gross = poly?.pnlAllUsd ?? null;
    const net = poly?.cashflowPnlUsd ?? null;
    const basisPnl = net ?? gross;
    const polyAdvantageUsd =
      basisPnl === null ? null : round2(basisPnl - customerDeskPnlUsd);
    const verdict =
      basisPnl === null ? null : verdictOf(customerDeskPnlUsd, basisPnl);
    rows.push({
      customerId: customer.customerId,
      agentId: customer.agentId,
      contextType: customer.contextType,
      status: customer.status,
      wallet: link.wallet,
      attributionType: link.attributionType,
      confidenceBps: link.confidenceBps,
      customerDeskPnlUsd,
      deskVolumeUsd: round2(customer.lifetimeVolumeUsd),
      deskHoldPct,
      clvBps: customer.clvBps,
      sharpScore: customer.sharpScore,
      poly,
      polyBasisPnlUsd: basisPnl === null ? null : round2(basisPnl),
      pnlBasis: net !== null ? "NET" : gross !== null ? "GROSS" : null,
      feeResidualUsd: poly?.feeResidualUsd ?? null,
      valueKind: poly?.valueKind ?? null,
      polyAdvantageUsd,
      verdict,
      priorityUsd:
        polyAdvantageUsd !== null && polyAdvantageUsd > 0
          ? round2(polyAdvantageUsd * (link.confidenceBps / 10_000))
          : 0,
    });
  }
  rows.sort(
    (a, b) =>
      b.priorityUsd - a.priorityUsd || a.customerId.localeCompare(b.customerId),
  );

  const linkedCustomers = new Set(rows.map((row) => row.customerId));
  const withPoly = rows.filter((row) => row.poly !== null);
  const observedWalletSet = new Set(withPoly.map((row) => row.wallet));
  const count = (verdict: CrossVenueVerdict): number =>
    rows.filter((row) => row.verdict === verdict).length;
  const attributionTypes: Record<string, number> = {};
  for (const link of input.registry.links) {
    attributionTypes[link.attributionType] =
      (attributionTypes[link.attributionType] ?? 0) + 1;
  }

  const sum = (values: readonly number[]): number =>
    round2(values.reduce((a, b) => a + b, 0));
  const deskVolumeUsd = sum(rows.map((row) => row.deskVolumeUsd));
  const customerDeskPnlUsd = sum(rows.map((row) => row.customerDeskPnlUsd));

  // A wallet attributed to several customers is ambiguous: count its PnL once, and keep it out
  // of the advantage total so the same Polymarket result is not booked against two books.
  const customersByWallet = new Map<string, string[]>();
  for (const row of rows) pushTo(customersByWallet, row.wallet, row.customerId);
  const isShared = (wallet: string): boolean => {
    const linked = customersByWallet.get(wallet) ?? [];
    return new Set(linked).size > 1;
  };
  const sharedWalletRows = rows.filter((row) => isShared(row.wallet)).length;

  const observedWalletRows = [...observedWalletSet]
    .map((wallet) => observations.get(wallet))
    .filter((value): value is PolyObservation => value !== undefined);
  const basisOf = (poly: PolyObservation): number | null =>
    poly.cashflowPnlUsd ?? poly.pnlAllUsd;
  const polyPnlUsd = sum(
    observedWalletRows
      .map((poly) => basisOf(poly))
      .filter((value): value is number => value !== null),
  );
  const polyGrossPnlUsd = sum(
    observedWalletRows.map((poly) => poly.pnlAllUsd ?? 0),
  );
  const polyNetPnlUsd = sum(
    observedWalletRows
      .map((poly) => poly.cashflowPnlUsd)
      .filter((value): value is number => value !== null),
  );
  const polyFeeResidualUsd = sum(
    observedWalletRows
      .map((poly) => poly.feeResidualUsd)
      .filter((value): value is number => value !== null),
  );
  const netCovered = observedWalletRows.filter(
    (poly) => poly.cashflowPnlUsd !== null,
  ).length;
  const polyVolumeUsd = sum(
    observedWalletRows.map((poly) => poly.tradeVolumeUsd),
  );
  const unambiguous = rows.filter((row) => !isShared(row.wallet));

  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    generatedAtIso: new Date(input.now ?? Date.now()).toISOString(),
    evidence:
      withPoly.length === 0
        ? "FIXTURE"
        : withPoly.length < rows.length
          ? "MIXED"
          : "LIVE",
    coverage: {
      customersInBook: input.customers.length,
      linkedCustomers: linkedCustomers.size,
      linkYieldPct:
        input.customers.length > 0
          ? round2((linkedCustomers.size / input.customers.length) * 100)
          : 0,
      wallets: input.registry.stats.wallets,
      observedWallets: observedWalletSet.size,
      invalidWallets: input.registry.stats.invalid,
      multiWalletCustomers: input.registry.stats.multiWalletCustomers,
      sharedWallets: input.registry.stats.sharedWallets,
      attributionTypes,
    },
    value: {
      customersWithPoly: withPoly.length,
      customersWithPnl: rows.filter((row) => row.polyBasisPnlUsd !== null)
        .length,
      bothUp: count("BOTH_UP"),
      polyOnlyUp: count("POLY_ONLY_UP"),
      deskOnlyUp: count("DESK_ONLY_UP"),
      bothDown: count("BOTH_DOWN"),
      flat: count("FLAT"),
      deskVolumeUsd,
      customerDeskPnlUsd,
      deskHoldPct:
        deskVolumeUsd > 0
          ? round2((customerDeskPnlUsd / deskVolumeUsd) * 100)
          : null,
      polyPnlUsd,
      polyGrossPnlUsd,
      polyNetPnlUsd,
      polyFeeResidualUsd,
      netCoveragePct:
        observedWalletRows.length > 0
          ? round2((netCovered / observedWalletRows.length) * 100)
          : 0,
      polyVolumeUsd,
      polyAdvantageUsd: sum(
        unambiguous.map((row) => row.polyAdvantageUsd ?? 0),
      ),
      priorityUsd: sum(unambiguous.map((row) => row.priorityUsd)),
      sharedWalletRows,
    },
    customers: rows,
    quarantined: input.registry.quarantined,
    notes: [
      "[ASSUMPTION] customerDeskPnlUsd = -lifetime_net_usd: the fixture appears to store the desk's net; verify the sign against F402.",
      "polyAdvantageUsd is observational. It does not prove a hedge, layoff, or leakage without leg-level matching.",
      "Win rate and PnL come from public Polymarket APIs only; no key and no private customer data are sent.",
    ],
  };
}

// ============================================================================
// 6. LEG-LEVEL CROSS-DOMAIN MATCHING (SQLite observation store)
// ============================================================================

export interface CrossDomainLegMatch {
  readonly polyTicket: string;
  readonly polyWallet: string;
  readonly f402Ticket: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly attributionType: string;
  readonly gameId: string;
  readonly period: string;
  readonly subject: string;
  readonly marketKind: string;
  readonly polySide: string;
  readonly f402Side: string;
  /** MIRROR = same side at both venues; OPPOSITE = same market, other side (hedge shape). */
  readonly relation: "MIRROR" | "OPPOSITE";
  readonly polyLineHundredths: number | null;
  readonly f402LineHundredths: number | null;
  readonly lineDeltaHundredths: number | null;
  readonly betterVenue: "polymarket" | "internal" | "equal";
}

export interface CrossDomainCustomerSummary {
  readonly customerId: string;
  readonly agentId: string;
  readonly wallet: string;
  readonly matches: number;
  readonly mirror: number;
  readonly opposite: number;
  readonly layoffRiskLegs: number;
  readonly avgDeltaHundredths: number | null;
}

export interface CrossDomainMatchReport {
  readonly database: string;
  readonly matchedLegs: number;
  readonly mirrorLegs: number;
  readonly oppositeLegs: number;
  readonly sameLineLegs: number;
  readonly layoffRiskLegs: number;
  readonly customers: readonly CrossDomainCustomerSummary[];
  readonly matches: readonly CrossDomainLegMatch[];
  readonly notes: readonly string[];
}

export interface CrossDomainMatchOptions {
  readonly databasePath?: string;
  readonly customerId?: string;
  readonly maxLineDeltaHundredths?: number;
  readonly limit?: number;
}

interface MatchQueryRow {
  readonly poly_ticket: string;
  readonly poly_wallet: string;
  readonly f402_ticket: string;
  readonly customer_id: string;
  readonly agent_id: string | null;
  readonly attribution_type: string | null;
  readonly game_id: string;
  readonly period: string;
  readonly subject: string;
  readonly market_kind: string;
  readonly poly_side: string;
  readonly f402_side: string;
  readonly poly_line: number | bigint | null;
  readonly f402_line: number | bigint | null;
}

/**
 * Cross-domain leg matcher over `combo_observations_legs` + `wallet_customer_attributions`.
 *
 * Unlike `LayoffRiskEngine.queryLineDeltaMatches` (same side only), this keeps opposite-side
 * pairs so hedge shapes are visible, and reports the line delta for both.
 */
export function matchCustomerLegsAcrossVenues(
  db: Database,
  options: CrossDomainMatchOptions = {},
): CrossDomainMatchReport {
  const maxDelta = options.maxLineDeltaHundredths ?? 100;
  const limit = Math.max(1, options.limit ?? 500);
  const customerFilter =
    options.customerId === undefined
      ? null
      : options.customerId.trim().toUpperCase();

  const sql = `
    SELECT
      pm.source_ticket            AS poly_ticket,
      LOWER(pm.wallet_or_account) AS poly_wallet,
      f402.source_ticket          AS f402_ticket,
      UPPER(f402.wallet_or_account) AS customer_id,
      f402.agent_id               AS agent_id,
      attr.attribution_type       AS attribution_type,
      pm.game_id                  AS game_id,
      pm.period                   AS period,
      pm.subject                  AS subject,
      pm.market_kind              AS market_kind,
      pm.side                     AS poly_side,
      f402.side                   AS f402_side,
      pm.line_hundredths          AS poly_line,
      f402.line_hundredths        AS f402_line
    FROM combo_observations_legs pm
    JOIN combo_observations_legs f402
      ON pm.game_id = f402.game_id
     AND pm.period = f402.period
     AND pm.subject = f402.subject
     AND pm.market_kind = f402.market_kind
    JOIN wallet_customer_attributions attr
      ON LOWER(attr.proxy_wallet) = LOWER(pm.wallet_or_account)
     AND UPPER(attr.customer_id) = UPPER(f402.wallet_or_account)
    WHERE pm.source_venue = 'polymarket'
      AND f402.source_venue = 'f402'
      AND (?1 IS NULL OR UPPER(f402.wallet_or_account) = ?1)
      AND ABS(COALESCE(f402.line_hundredths, 0) - COALESCE(pm.line_hundredths, 0)) <= ?2
    ORDER BY f402.wallet_or_account, pm.game_id, pm.subject
    LIMIT ?3
  `;

  const rows = db
    .query(sql)
    .all(customerFilter, maxDelta, limit) as MatchQueryRow[];

  const matches: CrossDomainLegMatch[] = rows.map((row) => {
    const polyLine = sqlIntOrNull(row.poly_line);
    const f402Line = sqlIntOrNull(row.f402_line);
    const sameSide =
      row.poly_side.toUpperCase() === row.f402_side.toUpperCase();
    return {
      polyTicket: row.poly_ticket,
      polyWallet: row.poly_wallet,
      f402Ticket: row.f402_ticket,
      customerId: row.customer_id,
      agentId: (row.agent_id ?? "UNKNOWN").toUpperCase(),
      attributionType: row.attribution_type ?? "UNATTRIBUTED",
      gameId: row.game_id,
      period: row.period,
      subject: row.subject,
      marketKind: row.market_kind,
      polySide: row.poly_side,
      f402Side: row.f402_side,
      relation: sameSide ? "MIRROR" : "OPPOSITE",
      polyLineHundredths: polyLine,
      f402LineHundredths: f402Line,
      lineDeltaHundredths:
        polyLine === null || f402Line === null
          ? null
          : Math.abs(polyLine - f402Line),
      betterVenue:
        polyLine === null || f402Line === null
          ? "equal"
          : evaluateBetterVenue(
              row.market_kind,
              row.poly_side,
              polyLine,
              f402Line,
            ),
    };
  });

  const byCustomer = new Map<string, CrossDomainLegMatch[]>();
  for (const match of matches) pushTo(byCustomer, match.customerId, match);

  const customers: CrossDomainCustomerSummary[] = [...byCustomer.entries()]
    .map(([customerId, list]) => {
      const deltas = list
        .map((match) => match.lineDeltaHundredths)
        .filter((delta): delta is number => delta !== null);
      return {
        customerId,
        agentId: list[0]?.agentId ?? "UNKNOWN",
        wallet: list[0]?.polyWallet ?? "",
        matches: list.length,
        mirror: list.filter((match) => match.relation === "MIRROR").length,
        opposite: list.filter((match) => match.relation === "OPPOSITE").length,
        layoffRiskLegs: list.filter(
          (match) => match.betterVenue === "polymarket",
        ).length,
        avgDeltaHundredths:
          deltas.length === 0
            ? null
            : Math.round(
                (deltas.reduce((sum, delta) => sum + delta, 0) /
                  deltas.length) *
                  100,
              ) / 100,
      };
    })
    .sort(
      (a, b) =>
        b.matches - a.matches || a.customerId.localeCompare(b.customerId),
    );

  return {
    database: options.databasePath ?? ":memory:",
    matchedLegs: matches.length,
    mirrorLegs: matches.filter((match) => match.relation === "MIRROR").length,
    oppositeLegs: matches.filter((match) => match.relation === "OPPOSITE")
      .length,
    sameLineLegs: matches.filter((match) => match.lineDeltaHundredths === 0)
      .length,
    layoffRiskLegs: matches.filter(
      (match) => match.betterVenue === "polymarket",
    ).length,
    customers,
    matches,
    notes: [
      "Joins only legs with a registered customer<->wallet attribution; unattributed wallets are excluded.",
      "OPPOSITE is a shape flag, not proof of a hedge: the same customer can also have a directional view.",
      "Line delta uses integer hundredths, matching the combo_identity canonical units.",
    ],
  };
}

// ============================================================================
// 7. SEEDED DEMO (no live capture required)
// ============================================================================

/**
 * Seeds the observation store with the cross-market scenario used by the layoff-risk CLI.
 * Kept here as a callable so `dx bridge match --seed` works without a live capture.
 */
export function seedCrossDomainScenario(
  store: {
    insertAttribution: (attr: {
      proxyWallet: string;
      customerId: string;
      agentOwner: string;
      attributionType?: string;
      confidenceBps?: number;
    }) => void;
    ingestPolymarketCombo: (
      orderHash: string,
      proxyWallet: string,
      legs: readonly {
        competitionFamily?: string;
        period?: string | number;
        team?: string;
        participantCode?: string;
        marketKind?: string;
        side?: string;
        line?: number | string | null;
        productClass?: string;
      }[],
      stakeCents?: number,
      placedAt?: string,
    ) => void;
    ingestF402Ticket: (
      ticketNumber: string | number,
      wagerNumber: string | number,
      customerId: string,
      agentId: string,
      legs: readonly {
        ticketNumber: string | number;
        wagerNumber: string | number;
        customerId: string;
        agentId?: string;
        sportType?: string;
        period?: string | number;
        team?: string;
        shortDesc?: string;
        line?: number | string | null;
      }[],
      stakeCents?: number,
      placedAt?: string,
    ) => void;
  },
  registry: AttributionRegistry,
): void {
  for (const link of registry.links) {
    store.insertAttribution({
      proxyWallet: link.wallet,
      customerId: link.customerId,
      agentOwner: link.agentOwner,
      attributionType: link.attributionType,
      confidenceBps: link.confidenceBps,
    });
  }

  const bgd = registry.byCustomer.get("BGD101")?.[0]?.wallet;
  const mj = registry.byCustomer.get("MJ102")?.[0]?.wallet;
  const gp = registry.byCustomer.get("GP300")?.[0]?.wallet;
  const at = registry.byCustomer.get("AT10359")?.[0]?.wallet;

  if (bgd !== undefined) {
    store.ingestPolymarketCombo("0xbridge_sacst_1", bgd, [
      {
        competitionFamily: "CFB",
        period: "game",
        team: "SAC_ST",
        marketKind: "spread",
        side: "UNDERDOG",
        line: 9.5,
        productClass: "parlay",
      },
    ]);
    store.ingestF402Ticket("7741", "1", "BGD101", "BIGDAD", [
      {
        ticketNumber: "7741",
        wagerNumber: "1",
        customerId: "BGD101",
        agentId: "BIGDAD",
        sportType: "CFB",
        period: 0,
        team: "SAC_ST",
        shortDesc: "P SAC_ST +10.0 -110",
        line: 10.0,
      },
    ]);
  }
  if (mj !== undefined) {
    store.ingestPolymarketCombo("0xbridge_nba_lal_1", mj, [
      {
        competitionFamily: "NBA",
        period: "game",
        team: "LAL",
        marketKind: "spread",
        side: "FAVORITE",
        line: -2.5,
        productClass: "sgp",
      },
    ]);
    store.ingestF402Ticket("9101", "1", "MJ102", "MJ2026", [
      {
        ticketNumber: "9101",
        wagerNumber: "1",
        customerId: "MJ102",
        agentId: "MJ2026",
        sportType: "NBA",
        period: 0,
        team: "LAL",
        shortDesc: "C LAKERS -3.5 -110",
        line: -3.5,
      },
    ]);
  }
  if (gp !== undefined) {
    store.ingestPolymarketCombo("0xbridge_nba_bos_1", gp, [
      {
        competitionFamily: "NBA",
        period: "game",
        team: "BOS",
        marketKind: "spread",
        side: "FAVORITE",
        line: -5.5,
        productClass: "parlay",
      },
    ]);
    store.ingestF402Ticket("9201", "1", "GP300", "GPRO50RSK", [
      {
        ticketNumber: "9201",
        wagerNumber: "1",
        customerId: "GP300",
        agentId: "GPRO50RSK",
        sportType: "NBA",
        period: 0,
        team: "BOS",
        shortDesc: "P CELTICS -6.5 -110",
        line: -6.5,
      },
    ]);
  }
  if (at !== undefined) {
    store.ingestPolymarketCombo("0xbridge_nba_den_1", at, [
      {
        competitionFamily: "NBA",
        period: "game",
        team: "DEN",
        marketKind: "total",
        side: "OVER",
        line: 224.5,
        productClass: "parlay",
      },
    ]);
    store.ingestF402Ticket("9301", "1", "AT10359", "ATEAM", [
      {
        ticketNumber: "9301",
        wagerNumber: "1",
        customerId: "AT10359",
        agentId: "ATEAM",
        sportType: "NBA",
        period: 0,
        team: "DEN",
        shortDesc: "P NUGGETS OVER 225.0 -110",
        line: 225.0,
      },
    ]);
  }

  // Same customer family, opposite side on the same total: a middle/hedge shape, not proof.
  const da = registry.byCustomer.get("DA4401")?.[0]?.wallet;
  if (da !== undefined) {
    store.ingestPolymarketCombo("0xbridge_nba_den_under_1", da, [
      {
        competitionFamily: "NBA",
        period: "game",
        team: "DEN",
        marketKind: "total",
        side: "UNDER",
        line: 224.5,
        productClass: "parlay",
      },
    ]);
    store.ingestF402Ticket("9302", "1", "DA4401", "JUICEPLUS", [
      {
        ticketNumber: "9302",
        wagerNumber: "1",
        customerId: "DA4401",
        agentId: "JUICEPLUS",
        sportType: "NBA",
        period: 0,
        team: "DEN",
        shortDesc: "P NUGGETS OVER 225.0 -110",
        line: 225.0,
      },
    ]);
  }
}

/** Extracts line hundredths from a SQLite row value, tolerating bigint. */
export function lineOf(value: number | bigint | null): number | null {
  return sqlIntOrNull(value);
}

/** Formats a line delta in hundredths for reporting. */
export function formatDeltaHundredths(delta: number | null): string {
  if (delta === null) return "n/a";
  return `${delta >= 0 ? "+" : ""}${(delta / 100).toFixed(2)}`;
}

/** LineHundredths brand re-export for callers that compare against the identity engine. */
export type BridgeLineHundredths = LineHundredths;

/** Convenience for tests and callers that only need the numeric SQL coercion. */
export function toInt(value: number | bigint | null): number {
  return sqlInt(value);
}
