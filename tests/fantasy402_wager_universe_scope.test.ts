import { describe, expect, test } from "bun:test";
import {
  activeWagerObservationSlices,
  activeWagerObservationSlicesForSettlementCount,
  assertPatternClaimAllowed,
  FANTASY402_MANAGER_FEEDS,
  patternProvability,
  PATTERN_SCOPE_MATRIX,
  WagerUniverseScopeError,
} from "../lib/fantasy402_wager_universe_scope.ts";

describe("fantasy402_wager_universe_scope", () => {
  test("getPending slice excludes settled universe", () => {
    expect(FANTASY402_MANAGER_FEEDS.getPending.includesSettledWagers).toBe(
      false,
    );
    expect(FANTASY402_MANAGER_FEEDS.getPending.includesFutureGameWagers).toBe(
      true,
    );
  });

  test("pending-only active slices block outcome patterns", () => {
    const active = activeWagerObservationSlices();
    expect(patternProvability("pending_price_spike", active)).toBe("proven");
    expect(patternProvability("win_loss_rate", active)).toBe("blocked");
    expect(patternProvability("cancel_rate", active)).toBe("blocked");
  });

  test("settlement slice unlocks win/loss pattern class", () => {
    const withHistory = activeWagerObservationSlicesForSettlementCount(1);
    expect(withHistory.has("settlement_history")).toBe(true);
    expect(patternProvability("win_loss_rate", withHistory)).toBe("proven");
    expect(
      PATTERN_SCOPE_MATRIX.find((r) => r.pattern === "win_loss_rate")
        ?.requiredSlices,
    ).toContain("settlement_history");
  });

  test("assertPatternClaimAllowed throws on blocked pattern", () => {
    expect(() => assertPatternClaimAllowed("cancel_rate")).toThrow(
      WagerUniverseScopeError,
    );
  });
});
