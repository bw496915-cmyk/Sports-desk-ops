// The only module that imports dashboard.toml.
//
// Bun parses the TOML at bundle time; TypeScript has no module declaration for
// it, so the import is suppressed and the exported shapes below are the contract.
// The shape itself is enforced at build time by scripts/validate_dashboard_config.ts,
// which parses the same bytes and fails on drift.
// @ts-expect-error - Bun's .toml loader has no TS module declaration
import { api, freshness, meta, thresholds, leagues } from "./dashboard.toml";

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

export interface DashboardApi {
  /** Empty for same-origin; otherwise a scheme+host, without a trailing slash. */
  readonly base: string;
  readonly tiers: string;
  readonly customers: string;
  readonly wagers: string;
  readonly dashboard: string;
}

export interface DashboardFreshness {
  readonly stale_after_minutes: number;
}

export const DASHBOARD_META: DashboardMeta = meta;
export const DASHBOARD_THRESHOLDS: DashboardThresholds = thresholds;
export const DASHBOARD_LEAGUES: DashboardLeagues = leagues;
export const DASHBOARD_API: DashboardApi = api;
export const DASHBOARD_FRESHNESS: DashboardFreshness = freshness;

/** Loopback hosts that may override `[api].base` at runtime for a dev API. */
const DEV_OVERRIDE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `?apiBase=http://127.0.0.1:4021` wins over the committed base, so a dev session does not
 * need a hand edit of the TOML. Only loopback origins are accepted; anything else is ignored
 * rather than silently redirecting feed reads.
 */
function devApiBaseOverride(): string | null {
  const page = (globalThis as { location?: { search?: string } }).location;
  if (!page) return null;
  const raw = new URLSearchParams(page.search ?? "").get("apiBase");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return DEV_OVERRIDE_HOSTS.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a feed path against `[api].base` (origin only; `checkSchema` rejects a path there).
 * The absolute `path` replaces any base path in `new URL()` rather than doubling it.
 */
export function dashboardApiUrl(
  path: string,
  base: string | null = null,
): string {
  const resolved = base ?? devApiBaseOverride() ?? DASHBOARD_API.base;
  if (!resolved) return path;
  return new URL(path, resolved).toString();
}
