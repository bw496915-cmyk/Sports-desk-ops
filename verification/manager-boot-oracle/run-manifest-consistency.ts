#!/usr/bin/env bun
/**
 * Gate (aa): manifest gate.status must match artifact-derived readiness (no hand-flip drift).
 *
 *   bun run verify:manifest-consistency
 */
import { join } from "node:path";

import {
  deriveManagerBootGates,
  diffManifestGateStatuses,
} from "../../lib/f402_manager_boot_gate_derive.ts";
import { emitGateFailed, GATE_EXIT_OK } from "../../lib/f402_gate_exit.ts";
import type { PinnedManifestWithExtracted } from "../../lib/f402_portal_oracle_slice.ts";

const REPO = join(import.meta.dir, "../..");
const MANIFEST = join(import.meta.dir, "pinned/manifest.json");
const manifest = (await Bun.file(
  MANIFEST,
).json()) as PinnedManifestWithExtracted;

const derived = await deriveManagerBootGates(REPO, manifest);
const mismatches = diffManifestGateStatuses(manifest, derived);

if (mismatches.length > 0) {
  emitGateFailed("F402_MANIFEST_GATE_STATUS_DRIFT", {
    mismatches,
    derived: {
      harRedactionProof: derived.harRedactionProof.phase,
      productionOracle: derived.productionOracle.phase,
      variance: derived.variance.phase,
    },
    fix: "Update pinned/manifest.json gate.status from derived phase (ready only when artifacts verify); never hand-flip ready without verify:manager-* passing",
  });
}

console.log(
  JSON.stringify({
    signal: "F402_MANIFEST_GATE_STATUS_OK",
    derived: {
      harRedactionProof: derived.harRedactionProof.phase,
      productionOracle: derived.productionOracle.phase,
      variance: derived.variance.phase,
    },
  }),
);
process.exit(GATE_EXIT_OK);
