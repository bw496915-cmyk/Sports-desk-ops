#!/usr/bin/env bun
/**
 * Gate (i): committed redaction proof from one real capture:f402-har run + sentinel sweep.
 *
 *   bun run verify:manager-har-redaction-proof
 */
import { join } from "node:path";

import { deriveHarRedactionProofGate } from "../../lib/f402_manager_boot_gate_derive.ts";
import {
  emitGateBlocked,
  emitGateFailed,
  GATE_EXIT_OK,
} from "../../lib/f402_gate_exit.ts";
import type { PinnedManifestWithExtracted } from "../../lib/f402_portal_oracle_slice.ts";

const REPO = join(import.meta.dir, "../..");
const MANIFEST = join(import.meta.dir, "pinned/manifest.json");
const manifest = (await Bun.file(MANIFEST).json()) as PinnedManifestWithExtracted;

const derived = await deriveHarRedactionProofGate(REPO, manifest);

if (derived.phase === "blocked") {
  emitGateBlocked("F402_HAR_REDACTION_PROOF_GATE_BLOCKED", {
    ownerRole: manifest.harRedactionProofGate?.ownerRole,
    next: manifest.harRedactionProofGate?.requires,
    action:
      "Run: bun run capture:f402-har (once, real session) → commit HAR + proof → bun run verify:manifest-consistency",
    proofPath: derived.proofPath,
    harPath: derived.harPath,
  });
}

if (derived.phase === "invalid") {
  emitGateFailed("F402_HAR_REDACTION_PROOF_INVALID", {
    harPath: derived.harPath,
    proofPath: derived.proofPath,
    ...derived.detail,
  });
}

console.log("manager-boot-oracle: HAR redaction proof gate satisfied");
process.exit(GATE_EXIT_OK);
