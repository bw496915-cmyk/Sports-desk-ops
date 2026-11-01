#!/usr/bin/env bun
/**
 * Gate (j): oracle on redacted production GENERAL — blocked until authenticated capture lands.
 *
 *   bun run verify:manager-oracle-production
 */
import { join } from "node:path";

import {
  deriveHarRedactionProofGate,
  deriveProductionOracleGate,
} from "../../lib/f402_manager_boot_gate_derive.ts";
import {
  emitGateBlocked,
  emitGateFailed,
  GATE_EXIT_OK,
} from "../../lib/f402_gate_exit.ts";
import type { PinnedManifestWithExtracted } from "../../lib/f402_portal_oracle_slice.ts";

const REPO = join(import.meta.dir, "../..");
const MANIFEST = join(import.meta.dir, "pinned/manifest.json");
const manifest = (await Bun.file(
  MANIFEST,
).json()) as PinnedManifestWithExtracted;
const gate = manifest.productionOracleGate;

if (gate === undefined) {
  emitGateFailed("F402_PRODUCTION_ORACLE_GATE_MISCONFIG", {
    detail: "manifest missing productionOracleGate",
  });
}

const derived = await deriveProductionOracleGate(REPO, manifest);

const harDerived = await deriveHarRedactionProofGate(REPO, manifest);
if (harDerived.phase !== "ready" && derived.phase !== "ready") {
  emitGateBlocked("F402_PRODUCTION_ORACLE_GATE_BLOCKED", {
    reason: "har_redaction_proof_not_ready",
    prerequisite:
      "verify:manager-har-redaction-proof (gate i) or envelope redact + snapshot pin (gate j)",
    harPhase: harDerived.phase,
    productionPhase: derived.phase,
    ownerRole: gate.ownerRole,
    captureActor: gate.captureActor,
  });
}

if (derived.phase === "blocked") {
  emitGateBlocked("F402_PRODUCTION_ORACLE_GATE_BLOCKED", {
    ownerRole: gate.ownerRole,
    captureActor: gate.captureActor,
    next: gate.requires,
    fixture: derived.generalFixture,
    action:
      "Gate j: proof-verified HAR → extract:f402-oracle-fixture → pin nestedSnapshotSha256 → verify:manifest-consistency",
    detail: derived.detail,
  });
}

if (derived.phase === "invalid") {
  emitGateFailed("F402_PRODUCTION_ORACLE_GATE_INVALID", {
    fixture: derived.generalFixture,
    expected: derived.nestedSnapshotSha256,
    live: derived.liveSnapshotSha256,
    ...derived.detail,
  });
}

console.log(
  "manager-boot-oracle: production GENERAL matches pinned nested snapshot",
);
process.exit(GATE_EXIT_OK);
