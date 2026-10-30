import { describe, expect, it } from "bun:test";
import { formatRouteThreshold } from "../lib/gen_tokens/route_threshold.ts";
import type { RouteThresholdRow } from "../lib/gen_tokens/tokens_ssot.ts";

describe("formatRouteThreshold", () => {
  it("formats consensus_lag", () => {
    expect(
      formatRouteThreshold({
        threshold_kind: "consensus_lag",
        max_lag_ms: 120,
      }),
    ).toBe('{ kind: "consensus_lag", maxLagMs: 120 }');
  });

  it("rejects unknown kind", () => {
    expect(() =>
      formatRouteThreshold({
        threshold_kind: "not_a_kind",
      } as unknown as RouteThresholdRow),
    ).toThrow(/unknown route threshold_kind/);
  });
});
