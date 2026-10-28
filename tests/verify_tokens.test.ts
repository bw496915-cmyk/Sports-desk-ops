/**
 * @file tests/verify_tokens.test.ts
 * @description Formal Specification & Invariant Verification Suite for Qwen3.5-4B Tokens.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INGESTION_CHANNELS,
  ROUTE_CIRCUITS,
  TELEMETRY_SURFACES,
  ALL_QWEN_TOKENS,
  parseAsColorHexInt,
  type IngestionChannelDefinition,
  type RouteCircuitDefinition,
  type SurfaceDefinition,
} from "../domain-branded-types.ts";
import {
  assertUniqueTokenColors,
  evaluatePerceptualDistances,
  evaluateWcagContrast,
  hexToRgb,
  rgbToLab,
  calculateDeltaE00,
  calculateContrastRatio,
  type TokenEntry,
} from "../validation/token_validator.ts";

const rootDir = resolve(import.meta.dir, "..");

describe("1. Single Source of Truth & Zero-Drift Regeneration", () => {
  it("test_assert_tokens_toml_is_valid_and_complete", async () => {
    const tomlPath = resolve(rootDir, "tokens.toml");
    const tomlText = await Bun.file(tomlPath).text();
    const parsed = Bun.TOML.parse(tomlText) as any;

    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.version).toBe("1.1.0");

    const surfaces = Object.values(parsed.surfaces);
    const ingestion = Object.values(parsed.ingestion);
    const routes = Object.values(parsed.routes);

    expect(surfaces.length).toBe(2);
    expect(ingestion.length).toBe(7);
    expect(routes.length).toBe(4);
    expect(surfaces.length + ingestion.length + routes.length).toBe(13);
  });

  it("test_assert_zero_drift_between_tokens_toml_and_source_code", async () => {
    const tomlPath = resolve(rootDir, "tokens.toml");
    const tomlText = await Bun.file(tomlPath).text();
    const parsed = Bun.TOML.parse(tomlText) as any;

    const ingestionList = Object.values(parsed.ingestion) as any[];
    const routeList = Object.values(parsed.routes) as any[];
    const surfaceList = Object.values(parsed.surfaces) as any[];

    // Verify all 7 ingestion channels match tokens.toml byte-for-byte
    for (const item of ingestionList) {
      const match = INGESTION_CHANNELS.find((c) => c.layerId === item.layer_id);
      expect(match).toBeDefined();
      expect(match!.hex).toBe(item.hex);
      expect(match!.tokenName).toBe(item.token_name);
      expect(match!.channelCode).toBe(item.channel_code);
      if (item.sla_kind === "latency") {
        expect(match!.sla.kind).toBe("latency");
        if (match!.sla.kind === "latency") {
          expect(match!.sla.latencySlaMs).toBe(item.sla_ms);
        }
      } else {
        expect(match!.sla.kind).toBe("sentinel_drop");
      }
    }

    // Verify all 4 routes match tokens.toml
    for (const item of routeList) {
      const match = ROUTE_CIRCUITS.find((r) => r.layerId === item.layer_id);
      expect(match).toBeDefined();
      expect(match!.hex).toBe(item.hex);
      expect(match!.tokenName).toBe(item.token_name);
      expect(match!.moveFlag).toBe(item.move_flag);
      expect(match!.triggerKind).toBe(item.trigger_kind);
      expect(match!.threshold.kind).toBe(item.threshold_kind);
      expect(match!.mitigationKind).toBe(item.mitigation_kind);
    }

    // Verify all 2 surfaces match tokens.toml
    for (const item of surfaceList) {
      const match = TELEMETRY_SURFACES.find((s) => s.layerId === item.layer_id);
      expect(match).toBeDefined();
      expect(match!.hex).toBe(item.hex);
      expect(match!.tokenName).toBe(item.token_name);
      expect(match!.targetViewport).toBe(item.viewport);
      expect(match!.colorDepth).toBe(item.color_depth);
    }
  });
});

describe("2. Color Uniqueness & CIEDE2000 Perceptual Evaluation", () => {
  const tokenEntries: TokenEntry[] = ALL_QWEN_TOKENS.map((t) => ({
    layerId: t.layerId,
    tokenName: t.tokenName,
    hex: t.hex,
  }));

  it("test_assert_zero_color_collisions_across_all_13_tokens", () => {
    expect(() => assertUniqueTokenColors(tokenEntries)).not.toThrow();

    const uniqueHexInts = new Set(
      tokenEntries.map((t) => parseAsColorHexInt(t.hex)),
    );
    expect(uniqueHexInts.size).toBe(13);
  });

  it("test_perceptual_distance_ciede2000_pairwise_evaluation", () => {
    const { pairwiseComparisons, violations } = evaluatePerceptualDistances(
      tokenEntries,
      7.0,
    );

    // No un-justified perceptual collisions allowed
    expect(violations).toEqual([]);

    // Audit documented intentional continuum pairs
    const pairMap = new Map(
      pairwiseComparisons.map((p) => [`${p.tokenA}:${p.tokenB}`, p.deltaE]),
    );

    function getDistance(a: string, b: string): number {
      const k1 = `${a}:${b}`;
      const k2 = `${b}:${a}`;
      return (pairMap.get(k1) ?? pairMap.get(k2))!;
    }

    // 1. Alert (#ef4444) vs Manager (#f43f5e)
    const alertManagerDE = getDistance("--sd-tier-alert", "--sd-route-manager");
    expect(alertManagerDE).toBeGreaterThanOrEqual(7.0);
    expect(alertManagerDE).toBeCloseTo(7.41, 1);

    // 2. Steam (#f59e0b) vs Pending Breaker (#d97706)
    const steamPendingDE = getDistance("--sd-tier-steam", "--sd-route-pending");
    expect(steamPendingDE).toBeGreaterThanOrEqual(10.0);
    expect(steamPendingDE).toBeCloseTo(12.22, 1);

    // 3. Rec Bias (#38bdf8) vs Devig (#06b6d4)
    const recDevigDE = getDistance("--sd-tier-rec-bias", "--sd-route-devig");
    expect(recDevigDE).toBeGreaterThanOrEqual(9.0);
    expect(recDevigDE).toBeCloseTo(9.34, 1);

    // 4. Emerald (#10b981) vs Whale (#28a745)
    const emeraldWhaleDE = getDistance("--sd-theme-emerald", "--sd-tier-whale");
    expect(emeraldWhaleDE).toBeGreaterThanOrEqual(10.0);
    expect(emeraldWhaleDE).toBeCloseTo(10.62, 1);
  });
});

describe("3. WCAG 2.1 Contrast Gate Against Dark Surfaces", () => {
  const tokenEntries: TokenEntry[] = ALL_QWEN_TOKENS.map((t) => ({
    layerId: t.layerId,
    tokenName: t.tokenName,
    hex: t.hex,
  }));

  const surfaceEntries: TokenEntry[] = TELEMETRY_SURFACES.map((s) => ({
    layerId: s.layerId,
    tokenName: s.tokenName,
    hex: s.hex,
  }));

  it("test_assert_all_ui_tokens_satisfy_wcag_ui_contrast_ratio_3_to_1", () => {
    const { contrastScores, violations } = evaluateWcagContrast(
      tokenEntries,
      surfaceEntries,
    );

    expect(violations).toEqual([]);

    for (const score of contrastScores) {
      // Every token against surface-bg and surface-cli must exceed 3.0:1
      expect(score.passesWcagUiComponent).toBe(true);
      expect(score.contrastRatio).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("test_assert_high_contrast_text_readability", () => {
    const bgRgb = hexToRgb("#070b14");

    // Standard primary text must achieve AAA contrast (> 15:1)
    const primaryTextRgb = hexToRgb("#f1f5f9");
    const primaryRatio = calculateContrastRatio(primaryTextRgb, bgRgb);
    expect(primaryRatio).toBeGreaterThan(15.0);

    // Muted text must achieve AA contrast (> 4.5:1)
    const mutedTextRgb = hexToRgb("#94a3b8");
    const mutedRatio = calculateContrastRatio(mutedTextRgb, bgRgb);
    expect(mutedRatio).toBeGreaterThan(7.0);

    // Retail Cyan (#1d84b5) on dark background achieves AA text contrast (> 4.5:1)
    const retailRgb = hexToRgb("#1d84b5");
    const retailRatio = calculateContrastRatio(retailRgb, bgRgb);
    expect(retailRatio).toBeGreaterThanOrEqual(4.5);
  });
});

describe("4. Discriminated Union Type Guardrails", () => {
  it("test_assert_blocked_sentinel_uses_sentinel_drop_kind_not_zero_ms", () => {
    const blocked = INGESTION_CHANNELS.find((c) => c.layerId === "L19.N0518")!;
    expect(blocked).toBeDefined();

    expect(blocked.sla.kind).toBe("sentinel_drop");

    // Negative check: ensure no raw polymorphic latency number was set to 0
    expect((blocked.sla as any).latencySlaMs).toBeUndefined();
  });

  it("test_assert_latency_channels_use_latency_kind_with_positive_ms", () => {
    const latencyChannels = INGESTION_CHANNELS.filter(
      (c) => c.sla.kind === "latency",
    );
    expect(latencyChannels.length).toBe(6);

    for (const c of latencyChannels) {
      if (c.sla.kind === "latency") {
        expect(typeof c.sla.latencySlaMs).toBe("number");
        expect(Number.isInteger(c.sla.latencySlaMs)).toBe(true);
        expect(c.sla.latencySlaMs).toBeGreaterThan(0);
      }
    }
  });

  it("test_assert_axis_2_routes_use_discriminated_threshold_and_typed_predicates", () => {
    const r25 = ROUTE_CIRCUITS.find((r) => r.layerId === "L25.N1882")!;
    expect(r25.threshold.kind).toBe("consensus_lag");
    if (r25.threshold.kind === "consensus_lag") {
      expect(r25.threshold.maxLagMs).toBe(5000);
    }
    expect(r25.triggerKind).toBe("ADVERSE_SELECTION");
    expect(r25.mitigationKind).toBe("DYNAMIC_REPRICE");

    const r26 = ROUTE_CIRCUITS.find((r) => r.layerId === "L26.N3104")!;
    expect(r26.threshold.kind).toBe("bayes_shrinkage");
    if (r26.threshold.kind === "bayes_shrinkage") {
      expect(r26.threshold.tauStar).toBe(0.68);
      expect(r26.threshold.minTickets).toBe(8);
    }
    expect(r26.triggerKind).toBe("CLV_MARGIN_DECAY");
    expect(r26.mitigationKind).toBe("SHRINKAGE_RECALIBRATE");

    const r27 = ROUTE_CIRCUITS.find((r) => r.layerId === "L27.N0912")!;
    expect(r27.threshold.kind).toBe("liquidity_depth");
    if (r27.threshold.kind === "liquidity_depth") {
      expect(r27.threshold.minDepthCents).toBe(100000);
    }
    expect(r27.triggerKind).toBe("ORDER_BOOK_EXHAUSTION");
    expect(r27.mitigationKind).toBe("CIRCUIT_BREAKER_HALT");

    const r28 = ROUTE_CIRCUITS.find((r) => r.layerId === "L28.N2501")!;
    expect(r28.threshold.kind).toBe("composite_risk_gate");
    if (r28.threshold.kind === "composite_risk_gate") {
      expect(r28.threshold.minToxicityScore).toBe(80);
      expect(r28.threshold.maxHoldRateBasisPoints).toBe(-5000);
      expect(r28.threshold.maxDeficitCents).toBe(10000000);
    }
    expect(r28.triggerKind).toBe("TERMINAL_DEFICIT_ESCALATION");
    expect(r28.mitigationKind).toBe("MANAGER_LIMIT_CLAMP");
  });

  it("test_assert_axis_3_surfaces_specify_coherent_viewports_and_protocols", () => {
    const dom = TELEMETRY_SURFACES.find((s) => s.layerId === "SURFACE.DOM")!;
    expect(dom.protocol).toContain("DOM");
    expect(dom.colorDepth).toBe("24-bit TrueColor RGB");

    const cli = TELEMETRY_SURFACES.find((s) => s.layerId === "SURFACE.CLI")!;
    expect(cli.targetViewport).toContain("DirectColor VT");
    expect(cli.protocol).toContain("ANSI 24-bit TrueColor");
    expect(cli.colorDepth).toBe("24-bit TrueColor RGB");
  });
});

describe("5. Dead-Token & Bi-Directional Reference Consistency", () => {
  it("test_assert_every_declared_token_is_present_in_dashboard_html_files", () => {
    const customerHtml = readFileSync(
      resolve(rootDir, "customer-churn-simulation-dashboard.html"),
      "utf-8",
    );
    const telegramHtml = readFileSync(
      resolve(rootDir, "telegram-miniapp-dashboard.html"),
      "utf-8",
    );

    for (const token of ALL_QWEN_TOKENS) {
      // Must be registered in @property
      expect(customerHtml).toContain(`@property ${token.tokenName}`);
      expect(telegramHtml).toContain(`@property ${token.tokenName}`);

      // Must be set in :root
      expect(customerHtml).toContain(`${token.tokenName}: ${token.hex};`);
      expect(telegramHtml).toContain(`${token.tokenName}: ${token.hex};`);
    }
  });
});

describe("6. Generative Property-Based Invariant Tests", () => {
  it("test_property_ciede2000_metric_axioms", () => {
    // Generate pseudo-random RGB triplets and assert mathematical metric space axioms:
    // 1. Identity of indiscernibles: d(x, x) == 0
    // 2. Non-negativity: d(x, y) >= 0
    // 3. Symmetry: d(x, y) == d(y, x)
    for (let seed = 1; seed <= 50; seed++) {
      const r1 = (seed * 37) % 256;
      const g1 = (seed * 73) % 256;
      const b1 = (seed * 111) % 256;

      const r2 = (seed * 53) % 256;
      const g2 = (seed * 89) % 256;
      const b2 = (seed * 127) % 256;

      const lab1 = rgbToLab({ r: r1, g: g1, b: b1 });
      const lab2 = rgbToLab({ r: r2, g: g2, b: b2 });

      // Axiom 1: Identity
      const dSelf = calculateDeltaE00(lab1, lab1);
      expect(dSelf).toBeCloseTo(0.0, 5);

      // Axiom 2: Non-negativity
      const d12 = calculateDeltaE00(lab1, lab2);
      expect(d12).toBeGreaterThanOrEqual(0.0);

      // Axiom 3: Symmetry
      const d21 = calculateDeltaE00(lab2, lab1);
      expect(d12).toBeCloseTo(d21, 5);
    }
  });

  it("test_property_wcag_contrast_ratio_bounds", () => {
    // Contrast ratio mathematically bounded in [1.0, 21.0] and strictly symmetric
    for (let seed = 1; seed <= 50; seed++) {
      const r1 = (seed * 41) % 256;
      const g1 = (seed * 67) % 256;
      const b1 = (seed * 97) % 256;

      const r2 = (seed * 31) % 256;
      const g2 = (seed * 83) % 256;
      const b2 = (seed * 113) % 256;

      const c1 = { r: r1, g: g1, b: b1 };
      const c2 = { r: r2, g: g2, b: b2 };

      const ratio12 = calculateContrastRatio(c1, c2);
      const ratio21 = calculateContrastRatio(c2, c1);

      // Bounded in [1.0, 21.0]
      expect(ratio12).toBeGreaterThanOrEqual(1.0);
      expect(ratio12).toBeLessThanOrEqual(21.0);

      // Symmetry
      expect(ratio12).toBeCloseTo(ratio21, 5);

      // Identity is exactly 1.0
      expect(calculateContrastRatio(c1, c1)).toBeCloseTo(1.0, 5);
    }
  });
});
