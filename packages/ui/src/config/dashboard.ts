// The only module that imports dashboard.toml.
//
// Bun parses the TOML at bundle time; TypeScript has no module declaration for
// it, so the import is suppressed and the exported shapes below are the contract.
// The shape itself is enforced at build time by scripts/validate_dashboard_config.ts,
// which parses the same bytes and fails on drift.
// @ts-expect-error - Bun's .toml loader has no TS module declaration
import { meta, thresholds, leagues } from "./dashboard.toml";

export interface DashboardMeta {
  /** ISO-8601 string: unquoted TOML dates become Temporal and crash the bundle. */
  readonly generated_at: string;
}

export interface DashboardThresholds {
  readonly sharp: number;
  readonly steam: number;
}

export interface DashboardLeagues {
  readonly names: readonly string[];
}

export const DASHBOARD_META: DashboardMeta = meta;
export const DASHBOARD_THRESHOLDS: DashboardThresholds = thresholds;
export const DASHBOARD_LEAGUES: DashboardLeagues = leagues;
