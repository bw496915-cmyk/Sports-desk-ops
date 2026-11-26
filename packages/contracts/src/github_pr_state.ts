/**
 * Canonical GitHub GraphQL PullRequest merge-state enums (`MergeStateStatus` and
 * `MergeableState`), verified by live introspection against `https://api.github.com/graphql`.
 *
 * Defined once in `@sportsdesk-ops/contracts` so CLI scripts, CI gates, dashboard views, and MCP
 * schemas share one zero-dependency source of truth.
 *
 * @file packages/contracts/src/github_pr_state.ts
 */

export const GITHUB_MERGE_STATE_STATUSES = [
  "CLEAN",
  "HAS_HOOKS",
  "UNSTABLE",
  "BEHIND",
  "BLOCKED",
  "DIRTY",
  "UNKNOWN",
] as const;

export type GithubMergeStateStatus =
  (typeof GITHUB_MERGE_STATE_STATUSES)[number];

export const GITHUB_MERGEABLE_STATES = [
  "MERGEABLE",
  "CONFLICTING",
  "UNKNOWN",
] as const;

export type GithubMergeableState = (typeof GITHUB_MERGEABLE_STATES)[number];

export interface GithubPrMergeSnapshot {
  readonly mergeStateStatus: GithubMergeStateStatus;
  readonly mergeable?: GithubMergeableState | undefined;
  readonly isDraft?: boolean | undefined;
}

const MERGE_STATE_SET: ReadonlySet<string> = new Set(
  GITHUB_MERGE_STATE_STATUSES,
);
const MERGEABLE_SET: ReadonlySet<string> = new Set(GITHUB_MERGEABLE_STATES);

/** Type guard for GitHub GraphQL `MergeStateStatus` enum values. */
export function isGithubMergeStateStatus(
  value: unknown,
): value is GithubMergeStateStatus {
  return typeof value === "string" && MERGE_STATE_SET.has(value);
}

/** Type guard for GitHub GraphQL `MergeableState` enum values. */
export function isGithubMergeableState(
  value: unknown,
): value is GithubMergeableState {
  return typeof value === "string" && MERGEABLE_SET.has(value);
}

/**
 * True only when the PR is non-draft, not conflicting, and GitHub reports `CLEAN` or `HAS_HOOKS`.
 */
export function isGithubPrReadyToMerge(
  snapshot: GithubPrMergeSnapshot,
): boolean {
  if (snapshot.isDraft === true) return false;
  if (snapshot.mergeable === "CONFLICTING") return false;
  return (
    snapshot.mergeStateStatus === "CLEAN" ||
    snapshot.mergeStateStatus === "HAS_HOOKS"
  );
}
