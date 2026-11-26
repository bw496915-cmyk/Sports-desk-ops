import { describe, expect, test } from "bun:test";

import {
  GITHUB_MERGE_STATE_STATUSES,
  GITHUB_MERGEABLE_STATES,
  isGithubMergeableState,
  isGithubMergeStateStatus,
  isGithubPrReadyToMerge,
} from "@sportsdesk-ops/contracts/github-pr-state";

describe("GithubMergeStateStatus contract", () => {
  test("matches the live 7-value GitHub GraphQL MergeStateStatus enum (excluding PullRequest.isDraft)", () => {
    expect(GITHUB_MERGE_STATE_STATUSES).toEqual([
      "CLEAN",
      "HAS_HOOKS",
      "UNSTABLE",
      "BEHIND",
      "BLOCKED",
      "DIRTY",
      "UNKNOWN",
    ]);
    expect(GITHUB_MERGEABLE_STATES).toEqual([
      "MERGEABLE",
      "CONFLICTING",
      "UNKNOWN",
    ]);
    expect(isGithubMergeStateStatus("CLEAN")).toBe(true);
    expect(isGithubMergeStateStatus("HAS_HOOKS")).toBe(true);
    expect(isGithubMergeStateStatus("DRAFT")).toBe(false);
    expect(isGithubMergeableState("MERGEABLE")).toBe(true);
    expect(isGithubMergeableState("READY")).toBe(false);
  });

  test("isGithubPrReadyToMerge gates on CLEAN/HAS_HOOKS, non-draft, and non-conflicting", () => {
    expect(
      isGithubPrReadyToMerge({
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
      }),
    ).toBe(true);
    expect(
      isGithubPrReadyToMerge({ mergeStateStatus: "HAS_HOOKS", isDraft: false }),
    ).toBe(true);
    expect(
      isGithubPrReadyToMerge({ mergeStateStatus: "CLEAN", isDraft: true }),
    ).toBe(false);
    expect(
      isGithubPrReadyToMerge({
        mergeStateStatus: "CLEAN",
        mergeable: "CONFLICTING",
      }),
    ).toBe(false);
    expect(isGithubPrReadyToMerge({ mergeStateStatus: "UNSTABLE" })).toBe(
      false,
    );
    expect(isGithubPrReadyToMerge({ mergeStateStatus: "BLOCKED" })).toBe(false);
    expect(isGithubPrReadyToMerge({ mergeStateStatus: "BEHIND" })).toBe(false);
    expect(isGithubPrReadyToMerge({ mergeStateStatus: "DIRTY" })).toBe(false);
    expect(isGithubPrReadyToMerge({ mergeStateStatus: "UNKNOWN" })).toBe(false);
  });
});
