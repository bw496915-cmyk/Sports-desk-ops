/**
 * @file lib/wager_config.ts
 * @description Declarative wager tier & surveillance configuration loader (`config/wager_tiers.toml`).
 * Parsed with native Bun.TOML and validated with Zod.
 */

import { TOML } from "bun";
import { z } from "zod";
import { auditConfig } from "./audit_log.ts";

export const DEFAULT_WAGER_TIERS_CONFIG_PATH = "config/wager_tiers.toml";

export const tierEntrySchema = z.object({
  fg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  border: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  badge: z.string().min(1),
  minScore: z.number().min(0).max(10),
  action: z.string().min(1),
  alertTelegram: z.boolean().default(false),
});

export const DEFAULT_SURFACE = {
  panel: "#0d1527",
  border: "#1e293b",
  text: "#f8fafc",
  muted: "#94a3b8",
  accent: "#38bdf8",
};

export const DEFAULT_SURVEILLANCE = {
  clvAlertThresholdCents: 10.0,
  steamTimeWindowSeconds: 120,
  highRiskThresholdUsd: 5000,
  inplayDelaySeconds: 3,
};

export const surfaceSchema = z.object({
  panel: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default(DEFAULT_SURFACE.panel),
  border: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default(DEFAULT_SURFACE.border),
  text: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default(DEFAULT_SURFACE.text),
  muted: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default(DEFAULT_SURFACE.muted),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default(DEFAULT_SURFACE.accent),
});

export const surveillanceSchema = z.object({
  clvAlertThresholdCents: z
    .number()
    .default(DEFAULT_SURVEILLANCE.clvAlertThresholdCents),
  steamTimeWindowSeconds: z
    .number()
    .int()
    .default(DEFAULT_SURVEILLANCE.steamTimeWindowSeconds),
  highRiskThresholdUsd: z
    .number()
    .default(DEFAULT_SURVEILLANCE.highRiskThresholdUsd),
  inplayDelaySeconds: z
    .number()
    .int()
    .default(DEFAULT_SURVEILLANCE.inplayDelaySeconds),
});

export const wagerTiersConfigSchema = z.object({
  surface: surfaceSchema.default(DEFAULT_SURFACE),
  tiers: z.record(
    z.enum(["CRITICAL", "STEAM", "LATENCY", "RECREATIONAL"]),
    tierEntrySchema,
  ),
  surveillance: surveillanceSchema.default(DEFAULT_SURVEILLANCE),
});

export type WagerTiersConfig = z.infer<typeof wagerTiersConfigSchema>;

let lastLoadedConfig: { path: string; config: WagerTiersConfig } | null = null;

/**
 * Compares two WagerTiersConfig structures using native Bun.deepEquals in strict mode.
 * Returns true if the configuration has changed, false if strictly identical.
 */
export function hasConfigChanged(
  prev: WagerTiersConfig,
  next: WagerTiersConfig,
): boolean {
  return !Bun.deepEquals(prev, next, true);
}

/**
 * Loads and validates declarative wager tier configuration from a TOML file.
 * Uses native Bun.TOML with strict Zod schema validation.
 * When options.dedupeAudit is true, suppresses redundant audit log entries if config is unchanged.
 */
export async function loadTomlConfig(
  path: string = DEFAULT_WAGER_TIERS_CONFIG_PATH,
  options?: { dedupeAudit?: boolean },
): Promise<WagerTiersConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }
  const text = await file.text();
  const raw = TOML.parse(text);
  const parsed = wagerTiersConfigSchema.parse(raw);

  const shouldAudit =
    !options?.dedupeAudit ||
    !lastLoadedConfig ||
    lastLoadedConfig.path !== path ||
    hasConfigChanged(lastLoadedConfig.config, parsed);

  if (shouldAudit) {
    auditConfig({
      action: "config_load",
      configPath: path,
      details: {
        tiersCount: Object.keys(parsed.tiers).length,
        clvAlertThresholdCents: parsed.surveillance.clvAlertThresholdCents,
      },
    });
    lastLoadedConfig = { path, config: parsed };
  }

  return parsed;
}

/**
 * Reloads configuration and returns whether it changed compared to the last loaded state.
 * Uses native Bun.deepEquals strict comparison. Emits audit log only when changed.
 */
export async function reloadTomlConfigIfChanged(
  path: string = DEFAULT_WAGER_TIERS_CONFIG_PATH,
): Promise<{ config: WagerTiersConfig; changed: boolean }> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }
  const text = await file.text();
  const raw = TOML.parse(text);
  const next = wagerTiersConfigSchema.parse(raw);

  const changed =
    !lastLoadedConfig ||
    lastLoadedConfig.path !== path ||
    hasConfigChanged(lastLoadedConfig.config, next);

  if (changed) {
    auditConfig({
      action: "config_load",
      configPath: path,
      details: {
        tiersCount: Object.keys(next.tiers).length,
        clvAlertThresholdCents: next.surveillance.clvAlertThresholdCents,
      },
    });
    lastLoadedConfig = { path, config: next };
  }

  return { config: next, changed };
}

/**
 * Resets the in-memory cached configuration state (useful for test isolation).
 */
export function resetConfigCache(): void {
  lastLoadedConfig = null;
}

export { loadTomlConfig as loadWagerTiersConfig };
