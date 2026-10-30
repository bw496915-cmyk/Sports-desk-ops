#!/usr/bin/env bun
/**
 * @file scripts/generate_tokens.ts
 * @description Single-Source Code Generator: tokens.toml -> TypeScript + CSS + HTML Dashboards.
 *
 * Enforces zero-drift invariants across the codebase.
 * Usage: bun run scripts/generate_tokens.ts (or bun run gen:tokens)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DASHBOARD_TEMPLATES,
  spliceDashboardHtml,
} from "../lib/gen_tokens/dashboard_templates.ts";
import {
  assertStrictGateEmission,
  buildManifestFromDisk,
  GEN_TOKENS_GATE_RUN_ID_ENV,
} from "../lib/gen_tokens/emission_manifest.ts";
import {
  GEN_TOKEN_EMISSION_MANIFEST,
  GEN_TOKEN_EMISSION_PATHS,
} from "../lib/gen_tokens/emission_targets.ts";
import {
  DOMAIN_BRANDED_SECTION7_MARKER,
  DOMAIN_BRANDED_TYPES_PATH,
} from "../lib/gen_tokens/domain_branded_section.ts";
import { formatRouteThreshold } from "../lib/gen_tokens/route_threshold.ts";

const rootDir = resolve(import.meta.dir, "..");
const tomlPath = resolve(rootDir, "tokens.toml");
const emittedThisRun: string[] = [];

function recordEmission(repoRelativePath: string): void {
  if (!GEN_TOKEN_EMISSION_PATHS.includes(repoRelativePath)) {
    throw new Error(
      `[gen:tokens] internal: unregistered emission path ${repoRelativePath}`,
    );
  }
  emittedThisRun.push(repoRelativePath);
}

function emitRepoFile(
  repoRelativePath: string,
  absolutePath: string,
  content: string,
): void {
  writeFileSync(absolutePath, content, "utf-8");
  recordEmission(repoRelativePath);
}

function writeEmissionManifest(): void {
  assertStrictGateEmission(emittedThisRun);
  const runId = process.env[GEN_TOKENS_GATE_RUN_ID_ENV];
  const manifest = buildManifestFromDisk(rootDir, emittedThisRun, runId);
  const manifestPath = resolve(rootDir, GEN_TOKEN_EMISSION_MANIFEST);
  mkdirSync(resolve(manifestPath, ".."), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

if (!Bun.file(tomlPath).size) {
  console.error(`Error: tokens.toml not found at ${tomlPath}`);
  process.exit(1);
}

const tomlText = await Bun.file(tomlPath).text();
const data = Bun.TOML.parse(tomlText) as any;

const surfaces = Object.values(data.surfaces) as any[];
const ingestion = Object.values(data.ingestion) as any[];
const routes = Object.values(data.routes) as any[];
const ui = Object.values(data.ui ?? {}) as any[];

const UI_ROLES = new Set(["surface", "border", "text"]);
for (const t of ui) {
  if (!UI_ROLES.has(t.role) || Bun.color(t.hex, "number") === null) {
    console.error(
      `[gen:tokens] Error: ui token ${t.token_name} needs role surface|border|text and a Bun.color-parseable hex (got role=${t.role}, hex=${t.hex})`,
    );
    process.exit(1);
  }
}

console.log(`[gen:tokens] Loaded tokens.toml (v${data.meta.version}):`);
console.log(` - Surfaces : ${surfaces.length}`);
console.log(` - Ingestion: ${ingestion.length}`);
console.log(` - Routes   : ${routes.length}`);
console.log(` - UI       : ${ui.length}`);

// ============================================================================
// 1. GENERATE DOMAIN-BRANDED-TYPES.TS (SECTION 7)
// ============================================================================
const domainBrandedTypesPath = resolve(rootDir, DOMAIN_BRANDED_TYPES_PATH);
const currentDomainBrandedText = readFileSync(domainBrandedTypesPath, "utf-8");

const section7Idx = currentDomainBrandedText.indexOf(
  DOMAIN_BRANDED_SECTION7_MARKER,
);

if (section7Idx === -1) {
  console.error(
    "Error: Could not locate Section 7 marker in domain-branded-types.ts",
  );
  process.exit(1);
}

const domainBrandedBase = currentDomainBrandedText
  .slice(0, section7Idx)
  .trimEnd();

let generatedSection7 = `${DOMAIN_BRANDED_SECTION7_MARKER}

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
  generatedSection7 += `  {
    tokenName: "${t.token_name}",
    hex: "${t.hex}",
    role: "${t.role}",
    description: "${t.description}",
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
emitRepoFile(
  DOMAIN_BRANDED_TYPES_PATH,
  domainBrandedTypesPath,
  newDomainBrandedText,
);
console.log(`[gen:tokens] Emitted updated domain-branded-types.ts`);

// ============================================================================
// 2. GENERATE CSS DECLARATIONS & SYNCHRONIZE DASHBOARDS
// ============================================================================
const allTokens = [...surfaces, ...ui, ...ingestion, ...routes];

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

for (const template of DASHBOARD_TEMPLATES) {
  const dashboardPath = resolve(rootDir, template.repoPath);
  let html = readFileSync(dashboardPath, "utf-8");
  html = spliceDashboardHtml(
    html,
    dashboardPath,
    template,
    houdiniCss,
    rootVarsCss,
    spliceOrExit,
  );
  emitRepoFile(template.repoPath, dashboardPath, html);
  console.log(`[gen:tokens] Emitted updated ${template.repoPath}`);
}

const bunBin = process.execPath || "bun";
const fmtPaths = emittedThisRun.map((p) => resolve(rootDir, p));
Bun.spawnSync([bunBin, "fmt", ...fmtPaths], {
  cwd: rootDir,
});
console.log(
  `[gen:tokens] Deterministically formatted generated files via bun fmt`,
);

writeEmissionManifest();
console.log("[gen:tokens] Generation completed successfully.");
