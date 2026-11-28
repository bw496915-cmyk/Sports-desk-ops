import { describe, expect, test } from "bun:test";
import {
  BUN_RELEASE_CHANNELS,
  type BunReleaseChannel,
  describeBunRelease,
  detectBunReleaseChannel,
  isBunReleaseChannel,
} from "@sportsdesk-ops/contracts/bun-release-channel";

describe("BunReleaseChannel contract", () => {
  test("closes the union to stable and canary without colliding with wager channels", () => {
    expect(BUN_RELEASE_CHANNELS).toEqual(["stable", "canary"]);
    expect(isBunReleaseChannel("stable")).toBe(true);
    expect(isBunReleaseChannel("canary")).toBe(true);
    expect(isBunReleaseChannel("gslive")).toBe(false);
    expect(isBunReleaseChannel("nightly")).toBe(false);
    expect(isBunReleaseChannel(null)).toBe(false);
  });

  test("classifies Bun semver strings and live runtime accurately", () => {
    const cases: readonly [string, BunReleaseChannel][] = [
      ["1.4.5", "stable"],
      ["1.4.5+a7733435c", "stable"],
      ["1.5.0", "stable"],
      ["1.4.5-canary.1", "canary"],
      ["1.5.0-canary.20261125+abc123", "canary"],
      ["canary", "canary"],
    ];
    for (const [version, expected] of cases) {
      expect(detectBunReleaseChannel(version)).toBe(expected);
    }

    const live = describeBunRelease();
    expect(live.version).toBe(Bun.version);
    expect(isBunReleaseChannel(live.channel)).toBe(true);
    expect(live.revision).toBe(Bun.revision);
  });
});
