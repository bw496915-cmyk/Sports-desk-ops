#!/usr/bin/env bun
/**
 * Gate (k): N≥3 redacted HAR captures characterized before parser hardening.
 *
 *   bun run verify:manager-oracle-variance
 */
import { join } from "node:path";

import { deriveVarianceGate } from "../../lib/f402_manager_boot_gate_derive.ts";
import {
  emitGateBlocked,
  emitGateFailed,
  GATE_EXIT_OK,
} from "../../lib/f402_gate_exit.ts";
import type { PinnedManifestWithExtracted } from "../../lib/f402_portal_oracle_slice.ts";

const REPO = join(import.meta.dir, "../..");
const MANIFEST = join(import.meta.dir, "pinned/manifest.json");
const manifest = (await Bun.file(MANIFEST).json()) as PinnedManifestWithExtracted;

const derived = await deriveVarianceGate(REPO, manifest);

if (derived.phase === "blocked") {
  emitGateBlocked("F402_VARIANCE_GATE_BLOCKED", {
    ownerRole: manifest.varianceGate?.ownerRole,
    minimumCaptures: derived.minimumCaptures,
    captureCount: derived.captureCount,
    indexPath: derived.indexPath,
    next: manifest.varianceGate?.requires,
    action:
      "Gate k: after production oracle ready — N≥3 redacted HARs in index → verify:manifest-consistency",
  });
}

if (derived.phase === "invalid") {
  emitGateFailed("F402_VARIANCE_GATE_INVALID", {
    indexPath: derived.indexPath,
    ...derived.detail,
  });
}

console.log(
  `manager-boot-oracle: variance gate satisfied (${derived.captureCount} captures)`,
);
process.exit(GATE_EXIT_OK);
