import { DOMAIN_BRANDED_SECTION7_MARKER } from "./domain_branded_section.ts";
import { formatRouteThreshold } from "./route_threshold.ts";
import type { TokensSsot } from "./tokens_ssot.ts";

export function renderDomainBrandedSection7(ssot: TokensSsot): string {
  const { surfaces, ingestion, routes, ui } = ssot;

  let out = `${DOMAIN_BRANDED_SECTION7_MARKER}

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

export type TriggerPredicateKind =
  | "ADVERSE_SELECTION"
  | "CLV_MARGIN_DECAY"
  | "ORDER_BOOK_EXHAUSTION"
  | "TERMINAL_DEFICIT_ESCALATION";

export type MitigationActionKind =
  | "DYNAMIC_REPRICE"
  | "SHRINKAGE_RECALIBRATE"
  | "CIRCUIT_BREAKER_HALT"
  | "MANAGER_LIMIT_CLAMP";

/**
 * Axis 1 Transport SLA Discriminated Union.
 * Eliminates synthetic "0 ms" latency sentinels: sentinel drops represent an un-executed filtering policy.
 */
export type TransportSla =
  | { readonly kind: "latency"; readonly latencySlaMs: number }
  | { readonly kind: "sentinel_drop" };

/**
 * Axis 2 Algorithmic Threshold Discriminated Union.
 * Completely eliminates polymorphic string typing across consensus lag, shrinkage, depth, and risk gates.
 */
export type RouteThreshold =
  | { readonly kind: "consensus_lag"; readonly maxLagMs: number }
  | { readonly kind: "bayes_shrinkage"; readonly tauStar: number; readonly minTickets: number }
  | { readonly kind: "liquidity_depth"; readonly minDepthCents: Cents }
  | {
      readonly kind: "composite_risk_gate";
      readonly minToxicityScore: number;
      readonly maxHoldRateBasisPoints: BasisPoints;
      readonly maxDeficitCents: Cents;
    };

/**
 * Axis 1: Ingestion Signal Channels (Layers 18–24).
 */
export interface IngestionChannelDefinition {
  readonly layerId: \`L\${number}.N\${string}\`;
  readonly tokenName: string;
  readonly hex: string;
  readonly channelCode: SignalChannelCode;
  readonly signalTier: string;
  readonly transportUri: string;
  readonly sla: TransportSla;
  readonly channelStatus: SignalChannelStatus;
  readonly volumeRule: string;
  readonly operationalRole: string;
}

/**
 * Axis 2: Risk Decision & Route Continuum (Layers 25–28).
 */
export interface RouteCircuitDefinition {
  readonly layerId: \`L\${number}.N\${string}\`;
  readonly tokenName: string;
  readonly hex: string;
  readonly routeName: string;
  readonly moveFlag: DecisionMoveFlag;
  readonly triggerKind: TriggerPredicateKind;
  readonly threshold: RouteThreshold;
  readonly mitigationKind: MitigationActionKind;
  readonly operationalRole: string;
}

/**
 * Axis 3: Telemetry Viewports & Rendering Surfaces.
 */
export interface SurfaceDefinition {
  readonly layerId: "SURFACE.DOM" | "SURFACE.CLI";
  readonly tokenName: string;
  readonly hex: string;
  readonly surfaceName: string;
  readonly targetViewport: string;
  readonly protocol: string;
  readonly colorDepth: string;
  readonly operationalRole: string;
}

export type AnyQwenNeuronDefinition =
  | IngestionChannelDefinition
  | RouteCircuitDefinition
  | SurfaceDefinition;

/**
 * Ingestion Signal Channels (Layers 18-24).
 * Generated directly from tokens.toml.
 */
export const INGESTION_CHANNELS: readonly IngestionChannelDefinition[] = [
`;

  for (const c of ingestion) {
    const slaCode =
      c.sla_kind === "latency"
        ? `{ kind: "latency", latencySlaMs: ${c.sla_ms} }`
        : `{ kind: "sentinel_drop" }`;

    out += `  {
    layerId: "${c.layer_id}",
    tokenName: "${c.token_name}",
    hex: "${c.hex}",
    channelCode: "${c.channel_code}",
    signalTier: "${c.signal_tier}",
    transportUri: "${c.transport_uri}",
    sla: ${slaCode},
    channelStatus: "${c.channel_status}",
    volumeRule: "${c.volume_rule}",
    operationalRole: "${c.operational_role}",
  },
`;
  }

  out += `];

/** Plane 2 latency SLA (ms) per lane — derived from \`INGESTION_CHANNELS\` / tokens.toml SSOT. */
export const SIGNAL_SLA_MS: Readonly<
  Record<SignalChannelCode, number | undefined>
> = Object.fromEntries(
  INGESTION_CHANNELS.map((c) => [
    c.channelCode,
    c.sla.kind === "latency" ? c.sla.latencySlaMs : undefined,
  ]),
) as Record<SignalChannelCode, number | undefined>;

/**
 * Decision & Route Continuum (Layers 25-28).
 * Generated directly from tokens.toml.
 */
export const ROUTE_CIRCUITS: readonly RouteCircuitDefinition[] = [
`;

  for (const r of routes) {
    const threshCode = formatRouteThreshold(r);
    out += `  {
    layerId: "${r.layer_id}",
    tokenName: "${r.token_name}",
    hex: "${r.hex}",
    routeName: "${r.route_name}",
    moveFlag: "${r.move_flag}",
    triggerKind: "${r.trigger_kind}",
    threshold: ${threshCode},
    mitigationKind: "${r.mitigation_kind}",
    operationalRole: "${r.operational_role}",
  },
`;
  }

  out += `];

/**
 * Telemetry Viewports & Rendering Surfaces.
 * Generated directly from tokens.toml.
 */
export const TELEMETRY_SURFACES: readonly SurfaceDefinition[] = [
`;

  for (const s of surfaces) {
    out += `  {
    layerId: "${s.layer_id}",
    tokenName: "${s.token_name}",
    hex: "${s.hex}",
    surfaceName: "${s.surface_name}",
    targetViewport: "${s.viewport}",
    protocol: "${s.protocol}",
    colorDepth: "${s.color_depth}",
    operationalRole: "${s.role}",
  },
`;
  }

  out += `];

/**
 * Dashboard UI chrome tokens (cards, borders, text). Not neurons: excluded from the
 * pairwise ΔE00 floor, gated by role-specific WCAG contrast instead.
 */
export interface UiTokenDefinition {
  readonly tokenName: string;
  readonly hex: string;
  readonly role: "surface" | "border" | "text";
  readonly description: string;
}

export const UI_TOKENS: readonly UiTokenDefinition[] = [
`;

  for (const t of ui) {
    out += `  {
    tokenName: "${t.token_name}",
    hex: "${t.hex}",
    role: "${t.role}",
    description: "${t.description}",
  },
`;
  }

  out += `];

/**
 * Complete 13-entity registry across all 3 decoupled axes.
 */
export const ALL_QWEN_TOKENS: readonly AnyQwenNeuronDefinition[] = [
  ...INGESTION_CHANNELS,
  ...ROUTE_CIRCUITS,
  ...TELEMETRY_SURFACES,
];
`;

  return out;
}
