/**
 * @file tests/bridge_badges.test.ts
 * @description The badges must be derived from the transport-bridge table, not
 * restated beside it, and must not carry an ungenerated colour literal.
 */

import { describe, expect, test } from "bun:test";
import { TRANSPORT_BRIDGE_SPECIFICATION_TABLE } from "../lib/bridge_and_channel_router.ts";
import { BRIDGE_STATUS_BADGES } from "../src/dashboard/bridge_badges.ts";

describe("BRIDGE_STATUS_BADGES", () => {
  test("covers the F402 ticker and the P118 tally", () => {
    expect(BRIDGE_STATUS_BADGES.map((badge) => badge.bridgeId)).toEqual([
      "BRIDGE_01_F402_BET_TICKER_STREAM",
      "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
    ]);
    expect(BRIDGE_STATUS_BADGES.map((badge) => badge.originDomain)).toEqual([
      "ORIGIN_SPORTSBOOK_FANTASY402",
      "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    ]);
    expect(BRIDGE_STATUS_BADGES.map((badge) => badge.topic)).toEqual([
      "f402-bet-ticker",
      "gslive-tally",
    ]);
  });

  test("matches the specification table field for field", () => {
    for (const badge of BRIDGE_STATUS_BADGES) {
      const specification =
        TRANSPORT_BRIDGE_SPECIFICATION_TABLE[badge.bridgeId];
      expect(badge.originDomain).toBe(specification.originDomain);
      expect(badge.topic).toBe(specification.webSocketSubscriptionTopic);
      expect(badge.freshnessSlaMs).toBe(specification.freshnessSlaDurationMs);
    }
  });

  test("carries no colour literal outside the token layer", () => {
    for (const badge of BRIDGE_STATUS_BADGES) {
      expect("hex" in badge).toBe(false);
      expect("color" in badge).toBe(false);
      expect(Object.keys(badge).sort()).toEqual([
        "bridgeId",
        "freshnessSlaMs",
        "label",
        "originDomain",
        "topic",
      ]);
    }
  });
});
