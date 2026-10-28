/**
 * @file tests/verify_tokens.test.ts
 * @description Specification-Grade CI Verification for Decoupled Neuron Registry & Color Invariants.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INGESTION_CHANNELS,
  ROUTE_CIRCUITS,
  TELEMETRY_SURFACES,
  ALL_QWEN_TOKENS,
  assertUniqueTokenColors,
  parseAsColorHexInt,
  type IngestionChannelDefinition,
  type RouteCircuitDefinition,
} from "../domain-branded-types.ts";

describe("Decoupled Three-Axis Architecture & CI Color Integrity", () => {
  it("test_assert_zero_color_collisions_across_all_13_tokens", () => {
    expect(() => assertUniqueTokenColors(ALL_QWEN_TOKENS)).not.toThrow();

    const uniqueHexInts = new Set(ALL_QWEN_TOKENS.map(t => parseAsColorHexInt(t.hex)));
    expect(uniqueHexInts.size).toBe(13);
  });

  it("test_assert_route_01_liquidity_breaker_does_not_collide_with_sgp_builder", () => {
    const l22Steam = INGESTION_CHANNELS.find(c => c.layerId === "L22.N1402");
    const l27Pending = ROUTE_CIRCUITS.find(r => r.layerId === "L27.N0912");

    expect(l22Steam).toBeDefined();
    expect(l27Pending).toBeDefined();

    expect(l22Steam!.hex).toBe("#f59e0b");
    expect(l27Pending!.hex).toBe("#d97706");
    expect(l22Steam!.hex).not.toBe(l27Pending!.hex);

    expect(parseAsColorHexInt(l22Steam!.hex)).toBe(0xf59e0b);
    expect(parseAsColorHexInt(l27Pending!.hex)).toBe(0xd97706);
  });

  it("test_assert_strict_numeric_transport_latency_sla_on_ingestion_channels", () => {
    expect(INGESTION_CHANNELS.length).toBe(7);

    for (const channel of INGESTION_CHANNELS) {
      expect(typeof channel.transportLatencySlaMs).toBe("number");
      expect(Number.isInteger(channel.transportLatencySlaMs)).toBe(true);
      expect(channel.transportLatencySlaMs).toBeGreaterThanOrEqual(0);
    }

    const slaMap = Object.fromEntries(
      INGESTION_CHANNELS.map(c => [c.layerId, c.transportLatencySlaMs])
    );

    expect(slaMap["L18.N0204"]).toBe(1500);
    expect(slaMap["L19.N0518"]).toBe(0);
    expect(slaMap["L20.N1105"]).toBe(1000);
    expect(slaMap["L21.N0884"]).toBe(250);
    expect(slaMap["L22.N1402"]).toBe(1000);
    expect(slaMap["L23.N0412"]).toBe(500);
    expect(slaMap["L24.N2019"]).toBe(2000);
  });

  it("test_assert_strict_move_flags_and_thresholds_on_route_circuits", () => {
    expect(ROUTE_CIRCUITS.length).toBe(4);

    const validFlags = new Set([
      "STEAM_CONVERGENCE",
      "SHRINKAGE_SHARP",
      "LIQUIDITY_HALT",
      "TERMINAL_ENFORCE",
    ]);

    for (const route of ROUTE_CIRCUITS) {
      expect(validFlags.has(route.moveFlag)).toBe(true);
      expect(typeof route.algorithmicThreshold).toBe("string");
      expect(route.algorithmicThreshold.length).toBeGreaterThan(0);
      expect(typeof route.mitigationAction).toBe("string");
      expect(route.mitigationAction.length).toBeGreaterThan(0);
    }
  });

  it("test_assert_html_dashboards_use_non_colliding_route_pending_hex", () => {
    const rootDir = resolve(import.meta.dir, "..");
    const customerHtml = readFileSync(resolve(rootDir, "customer-churn-simulation-dashboard.html"), "utf-8");
    const telegramHtml = readFileSync(resolve(rootDir, "telegram-miniapp-dashboard.html"), "utf-8");

    // Both dashboards must register --sd-route-pending with initial-value #d97706
    expect(customerHtml).toContain("initial-value: #d97706;");
    expect(customerHtml).toContain("--sd-route-pending: #d97706;");

    expect(telegramHtml).toContain("initial-value: #d97706;");
    expect(telegramHtml).toContain("--sd-route-pending: #d97706;");
  });
});
