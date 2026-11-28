/**
 * Canonical Bun runtime release-channel taxonomy (`"stable"` vs `"canary"`), kept explicitly
 * distinct from wager/feed `WagerChannel` and `Partner118Channel` types.
 *
 * @file packages/contracts/src/bun_release_channel.ts
 */

export const BUN_RELEASE_CHANNELS = ["stable", "canary"] as const;

export type BunReleaseChannel = (typeof BUN_RELEASE_CHANNELS)[number];

export interface BunReleaseDescriptor {
  readonly version: string;
  readonly channel: BunReleaseChannel;
  readonly revision: string | null;
}

const CANARY_TOKEN_RE = /(?:^|[-.+])canary(?:$|[-.0-9a-z])/i;

/** Type guard for closed `BunReleaseChannel` union members (`"stable" | "canary"`). */
export function isBunReleaseChannel(
  value: unknown,
): value is BunReleaseChannel {
  return value === "stable" || value === "canary";
}

/**
 * Classify a Bun version string (e.g. `"1.4.5"`, `"1.4.5-canary.1"`, `"1.5.0-canary.20261125+abc"`)
 * into its closed `BunReleaseChannel`. Defaults to active `Bun.version` when running under Bun.
 */
export function detectBunReleaseChannel(version?: string): BunReleaseChannel {
  const raw = (
    version ??
    (globalThis as { readonly Bun?: { readonly version?: string } }).Bun
      ?.version ??
    ""
  ).trim();
  return CANARY_TOKEN_RE.test(raw) ? "canary" : "stable";
}

/** Build a structured descriptor from version + optional revision (defaults to live `Bun`). */
export function describeBunRelease(
  version?: string,
  revision?: string | null,
): BunReleaseDescriptor {
  const bunGlobal = (
    globalThis as {
      readonly Bun?: { readonly version?: string; readonly revision?: string };
    }
  ).Bun;
  const resolvedVersion = (version ?? bunGlobal?.version ?? "").trim();
  const rawRev = revision === undefined ? bunGlobal?.revision : revision;
  const resolvedRevision =
    typeof rawRev === "string" && rawRev.trim() ? rawRev.trim() : null;
  return {
    version: resolvedVersion,
    channel: detectBunReleaseChannel(resolvedVersion),
    revision: resolvedRevision,
  };
}
