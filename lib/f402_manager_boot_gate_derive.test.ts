import { describe, expect, test } from "bun:test";

import {
  diffManifestGateStatuses,
  type DerivedManagerBootGates,
} from "./f402_manager_boot_gate_derive.ts";
import type { PinnedManifestWithExtracted } from "./f402_portal_oracle_slice.ts";

describe("diffManifestGateStatuses", () => {
  test("flags hand-flipped ready when derived blocked", () => {
    const manifest = {
      harRedactionProofGate: { status: "ready" },
      productionOracleGate: { status: "blocked" },
      varianceGate: { status: "blocked" },
    } as PinnedManifestWithExtracted;
    const derived = {
      harRedactionProof: { phase: "blocked", harPath: "h", proofPath: "p" },
      productionOracle: {
        phase: "blocked",
        generalFixture: "f",
        nestedSnapshotSha256: null,
      },
      variance: {
        phase: "blocked",
        indexPath: "i",
        captureCount: 0,
        minimumCaptures: 3,
      },
    } as DerivedManagerBootGates;
    const mismatches = diffManifestGateStatuses(manifest, derived);
    expect(mismatches.some((m) => m.gate === "harRedactionProofGate")).toBe(true);
  });
});
