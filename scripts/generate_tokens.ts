#!/usr/bin/env bun
/**
 * @file scripts/generate_tokens.ts
 * @description Single-Source Code Generator: tokens.toml -> TypeScript + CSS + HTML Dashboards.
 *
 * Enforces zero-drift invariants across the codebase.
 * Usage: bun run scripts/generate_tokens.ts (or bun run gen:tokens)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const tomlPath = resolve(rootDir, "tokens.toml");

if (!Bun.file(tomlPath).size) {
  console.error(`Error: tokens.toml not found at ${tomlPath}`);
  process.exit(1);
}

const tomlText = await Bun.file(tomlPath).text();
const data = Bun.TOML.parse(tomlText) as any;

const surfaces = Object.values(data.surfaces) as any[];
const ingestion = Object.values(data.ingestion) as any[];
const routes = Object.values(data.routes) as any[];

console.log(`[gen:tokens] Loaded tokens.toml (v${data.meta.version}):`);
console.log(` - Surfaces : ${surfaces.length}`);
console.log(` - Ingestion: ${ingestion.length}`);
console.log(` - Routes   : ${routes.length}`);

// ============================================================================
// 1. GENERATE DOMAIN-BRANDED-TYPES.TS (SECTION 7)
// ============================================================================
const domainBrandedTypesPath = resolve(rootDir, "domain-branded-types.ts");
const currentDomainBrandedText = readFileSync(domainBrandedTypesPath, "utf-8");

// Locate Section 7 marker
const section7Marker =
  "// ============================================================================\n// 7. QWEN3.5-4B NEURON REGISTRY & DECOUPLED THREE-AXIS SCHEMAS (LAYERS 18-28)\n// ============================================================================";
const section7Idx = currentDomainBrandedText.indexOf(section7Marker);

if (section7Idx === -1) {
  console.error(
    "Error: Could not locate Section 7 marker in domain-branded-types.ts",
  );
  process.exit(1);
}

const domainBrandedBase = currentDomainBrandedText
  .slice(0, section7Idx)
  .trimEnd();

let generatedSection7 = `${section7Marker}

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

  generatedSection7 += `  {
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

generatedSection7 += `];

/**
 * Decision & Route Continuum (Layers 25-28).
 * Generated directly from tokens.toml.
 */
export const ROUTE_CIRCUITS: readonly RouteCircuitDefinition[] = [
`;

for (const r of routes) {
  let threshCode = "";
  if (r.threshold_kind === "consensus_lag") {
    threshCode = `{ kind: "consensus_lag", maxLagMs: ${r.max_lag_ms} }`;
  } else if (r.threshold_kind === "bayes_shrinkage") {
    threshCode = `{ kind: "bayes_shrinkage", tauStar: ${r.tau_star}, minTickets: ${r.min_tickets} }`;
  } else if (r.threshold_kind === "liquidity_depth") {
    threshCode = `{ kind: "liquidity_depth", minDepthCents: parseAsCents(${r.min_depth_cents}) }`;
  } else if (r.threshold_kind === "composite_risk_gate") {
    threshCode = `{ kind: "composite_risk_gate", minToxicityScore: ${r.min_toxicity_score}, maxHoldRateBasisPoints: parseAsBasisPoints(${r.max_hold_rate_basis_points}, true), maxDeficitCents: parseAsCents(${r.max_deficit_cents}) }`;
  }

  generatedSection7 += `  {
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

generatedSection7 += `];

/**
 * Telemetry Viewports & Rendering Surfaces.
 * Generated directly from tokens.toml.
 */
export const TELEMETRY_SURFACES: readonly SurfaceDefinition[] = [
`;

for (const s of surfaces) {
  generatedSection7 += `  {
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

generatedSection7 += `];

/**
 * Complete 13-entity registry across all 3 decoupled axes.
 */
export const ALL_QWEN_TOKENS: readonly AnyQwenNeuronDefinition[] = [
  ...INGESTION_CHANNELS,
  ...ROUTE_CIRCUITS,
  ...TELEMETRY_SURFACES,
];
`;

const newDomainBrandedText = `${domainBrandedBase}\n\n${generatedSection7}`;
writeFileSync(domainBrandedTypesPath, newDomainBrandedText, "utf-8");
console.log(`[gen:tokens] Emitted updated domain-branded-types.ts`);

// ============================================================================
// 2. GENERATE CSS DECLARATIONS & SYNCHRONIZE DASHBOARDS
// ============================================================================
const allTokens = [...surfaces, ...ingestion, ...routes];

function generateHoudiniPropertyCss(): string {
  let css =
    "    /* ==========================================================================\n";
  css +=
    "       1. CSS Houdini @property Declarations (Generated from tokens.toml)\n";
  css +=
    "       Enforces specification-grade design tokens and prevents silent property drop.\n";
  css +=
    "       ========================================================================== */\n";

  for (const t of allTokens) {
    css += `    @property ${t.token_name} {\n`;
    css += `      syntax: '<color>';\n`;
    css += `      inherits: true;\n`;
    css += `      initial-value: ${t.hex};\n`;
    css += `    }\n`;
  }
  return css;
}

function generateRootVariablesCss(): string {
  let css = "    :root {\n";
  css +=
    "      /* Generated from tokens.toml (v" + data.meta.version + ") */\n";
  for (const t of allTokens) {
    css += `      ${t.token_name}: ${t.hex};\n`;
  }
  return css;
}

function spliceOrExit(
  html: string,
  filePath: string,
  marker: RegExp,
  replacement: string,
): string {
  if (!marker.test(html)) {
    console.error(
      `[gen:tokens] Error: splice marker not found in ${filePath}: ${marker.source}`,
    );
    process.exit(1);
  }
  return html.replace(marker, replacement);
}

const houdiniCss = generateHoudiniPropertyCss();
const rootVarsCss = generateRootVariablesCss();

// Update customer-churn-simulation-dashboard.html
const customerDashboardPath = resolve(
  rootDir,
  "customer-churn-simulation-dashboard.html",
);
let customerHtml = readFileSync(customerDashboardPath, "utf-8");

// Regex update for Houdini property block
const houdiniRegex =
  /\/\* ==========================================================================\s+1\. CSS Houdini @property Declarations[\s\S]*?(?=\/\* Core Status and Component Tokens|\/\* ==========================================================================\s+2\. Canonical :root)/;
customerHtml = spliceOrExit(
  customerHtml,
  customerDashboardPath,
  houdiniRegex,
  houdiniCss.trim() + "\n\n",
);

// Regex update for :root variables
const rootVarsRegex =
  /:root\s*\{\s*\/\* Generated from tokens\.toml \(v[^)]*\) \*\/[\s\S]*?(?=--sd-primary:)/;
customerHtml = spliceOrExit(
  customerHtml,
  customerDashboardPath,
  rootVarsRegex,
  rootVarsCss + "\n      ",
);

writeFileSync(customerDashboardPath, customerHtml, "utf-8");
console.log(
  `[gen:tokens] Emitted updated customer-churn-simulation-dashboard.html`,
);

// Update telegram-miniapp-dashboard.html
const telegramDashboardPath = resolve(
  rootDir,
  "telegram-miniapp-dashboard.html",
);
let telegramHtml = readFileSync(telegramDashboardPath, "utf-8");

const tmaHoudiniRegex =
  /\/\* ==========================================================================\s+1\. CSS Houdini @property Declarations[\s\S]*?(?=@property --sd-primary|\/\* ==========================================================================\s+2\. TMA Theme Mapping)/;
telegramHtml = spliceOrExit(
  telegramHtml,
  telegramDashboardPath,
  tmaHoudiniRegex,
  houdiniCss.trim() + "\n\n    ",
);

telegramHtml = spliceOrExit(
  telegramHtml,
  telegramDashboardPath,
  rootVarsRegex,
  rootVarsCss + "\n      ",
);

writeFileSync(telegramDashboardPath, telegramHtml, "utf-8");
console.log(`[gen:tokens] Emitted updated telegram-miniapp-dashboard.html`);

// Automatically run bun fmt on touched files
const bunBin = process.execPath || "bun";
Bun.spawnSync(
  [
    bunBin,
    "fmt",
    domainBrandedTypesPath,
    customerDashboardPath,
    telegramDashboardPath,
  ],
  {
    cwd: rootDir,
  },
);
console.log(
  `[gen:tokens] Deterministically formatted generated files via bun fmt`,
);

console.log("[gen:tokens] Generation completed successfully.");
