/**
 * @file tests/wager_tiers_toml.test.ts
 * @description Verification suite for declarative TOML wager tier configuration
 * parsed with native Bun.TOML and validated with Zod.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_WAGER_TIERS_CONFIG_PATH,
  hasConfigChanged,
  loadTomlConfig,
  reloadTomlConfigIfChanged,
  resetConfigCache,
  wagerTiersConfigSchema,
} from "../lib/wager_config.ts";

describe("Declarative Wager Tiers TOML Config (Bun.TOML)", () => {
  it("loads config/wager_tiers.toml and validates all tier entries", async () => {
    const config = await loadTomlConfig(DEFAULT_WAGER_TIERS_CONFIG_PATH);

    // Verify Surface
    expect(config.surface.panel).toBe("#0d1527");
    expect(config.surface.text).toBe("#f8fafc");

    // Verify Tiers
    expect(config.tiers.CRITICAL).toBeDefined();
    expect(config.tiers.CRITICAL.badge).toContain("CRITICAL");
    expect(config.tiers.CRITICAL.minScore).toBe(9.0);
    expect(config.tiers.CRITICAL.action).toBe("ALERT_OPERATOR");
    expect(config.tiers.CRITICAL.alertTelegram).toBe(true);

    expect(config.tiers.STEAM).toBeDefined();
    expect(config.tiers.STEAM.badge).toContain("STEAM");
    expect(config.tiers.STEAM.minScore).toBe(8.0);

    expect(config.tiers.LATENCY).toBeDefined();
    expect(config.tiers.LATENCY.badge).toContain("LATENCY");

    expect(config.tiers.RECREATIONAL).toBeDefined();
    expect(config.tiers.RECREATIONAL.minScore).toBe(0.0);

    // Verify Surveillance
    expect(config.surveillance.clvAlertThresholdCents).toBe(10.0);
    expect(config.surveillance.steamTimeWindowSeconds).toBe(120);
    expect(config.surveillance.highRiskThresholdUsd).toBe(5000);
  });

  it("throws when config file does not exist", async () => {
    expect(
      loadTomlConfig("config/non_existent_tiers_file.toml"),
    ).rejects.toThrow("Config file not found");
  });

  it("fails schema validation on invalid hex color or out-of-range score", () => {
    const invalidConfig = {
      tiers: {
        CRITICAL: {
          fg: "not-a-hex",
          bg: "#000000",
          border: "#ffffff",
          badge: "Bad",
          minScore: 15.0, // > 10.0
          action: "TEST",
        },
      },
    };

    const res = wagerTiersConfigSchema.safeParse(invalidConfig);
    expect(res.success).toBe(false);
  });

  it("maintains browser bundle safety without pulling fs or bun modules eagerly", async () => {
    const buildResult = await Bun.build({
      entrypoints: ["src/dashboard/index.tsx"],
      target: "browser",
    });
    expect(buildResult.success).toBe(true);
    expect(buildResult.outputs.length).toBeGreaterThan(0);
    const bundleText = await buildResult.outputs[0]!.text();

    // Assert absence of server-only modules and Bun built-ins
    expect(bundleText).not.toContain("Bun.TOML");
    expect(bundleText).not.toContain('from "bun"');
    expect(bundleText).not.toContain('from"bun"');
    expect(bundleText).not.toContain('import("bun")');
    expect(bundleText).not.toContain('require("bun")');
  });

  it("detects configuration changes accurately using Bun.deepEquals (hasConfigChanged)", async () => {
    const config1 = await loadTomlConfig(DEFAULT_WAGER_TIERS_CONFIG_PATH);
    const configClone = JSON.parse(JSON.stringify(config1));

    // Identical structures -> hasConfigChanged is false
    expect(hasConfigChanged(config1, configClone)).toBe(false);

    // Mutate nested surveillance threshold -> hasConfigChanged is true
    const modifiedSurveillance = {
      ...config1,
      surveillance: {
        ...config1.surveillance,
        clvAlertThresholdCents: 15.0,
      },
    };
    expect(hasConfigChanged(config1, modifiedSurveillance)).toBe(true);

    // Mutate tier action -> hasConfigChanged is true
    const modifiedTier = {
      ...config1,
      tiers: {
        ...config1.tiers,
        CRITICAL: {
          ...config1.tiers.CRITICAL,
          minScore: 9.5,
        },
      },
    };
    expect(hasConfigChanged(config1, modifiedTier)).toBe(true);
  });

  it("verifies Bun.deepEquals strict vs non-strict mode semantics", () => {
    const base = { a: 1, b: [10, 20] };
    const exact = { a: 1, b: [10, 20] };
    const withUndefined = { a: 1, b: [10, 20], extra: undefined };

    // Standard structural equality
    expect(Bun.deepEquals(base, exact, true)).toBe(true);
    expect(Bun.deepEquals(base, exact, false)).toBe(true);

    // Strict mode distinguishes undefined properties
    expect(Bun.deepEquals(base, withUndefined, true)).toBe(false);
    expect(Bun.deepEquals(base, withUndefined, false)).toBe(true);
  });

  it("reloadTomlConfigIfChanged reloads and suppresses redundant audits when unchanged", async () => {
    resetConfigCache();

    // First load -> changed: true
    const res1 = await reloadTomlConfigIfChanged(
      DEFAULT_WAGER_TIERS_CONFIG_PATH,
    );
    expect(res1.changed).toBe(true);
    expect(res1.config.tiers.CRITICAL).toBeDefined();

    // Immediate second load without file changes -> changed: false
    const res2 = await reloadTomlConfigIfChanged(
      DEFAULT_WAGER_TIERS_CONFIG_PATH,
    );
    expect(res2.changed).toBe(false);
    expect(res2.config.tiers.CRITICAL.badge).toBe(
      res1.config.tiers.CRITICAL.badge,
    );
  });
});
