/**
 * Shared HAR redaction proof verification (gate i + synthetic fixtures).
 */

import {
  assertRedactedCaptureSweep,
  type HarRedactionProof,
} from "./f402_har_redaction_sweep.ts";
import { sha256HexText } from "./f402_portal_version_pin.ts";

export type HarProofVerifyOutcome =
  | { readonly kind: "ok" }
  | {
      readonly kind: "failed";
      readonly signal: string;
      readonly detail: Record<string, unknown>;
    };

export function parseHarRedactionProofDocument(
  raw: unknown,
): HarRedactionProof | HarProofVerifyOutcome {
  if (typeof raw !== "object" || raw === null) {
    return {
      kind: "failed",
      signal: "F402_HAR_PROOF_INVALID",
      detail: { reason: "proof JSON must be an object" },
    };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== 1) {
    return {
      kind: "failed",
      signal: "F402_HAR_PROOF_INVALID",
      detail: { schemaVersion: doc.schemaVersion },
    };
  }
  const sweep = doc.sweep;
  if (
    typeof sweep !== "object" ||
    sweep === null ||
    (sweep as Record<string, unknown>).ok !== true
  ) {
    return {
      kind: "failed",
      signal: "F402_HAR_PROOF_INVALID",
      detail: { sweep },
    };
  }
  if (typeof doc.harSha256 !== "string" || doc.harSha256 === "") {
    return {
      kind: "failed",
      signal: "F402_HAR_PROOF_INVALID",
      detail: { harSha256: doc.harSha256 },
    };
  }
  return raw as HarRedactionProof;
}

export async function verifyHarRedactionProofFiles(options: {
  readonly proofPath: string;
  readonly harPath: string;
  readonly requireListAgents?: boolean;
}): Promise<HarProofVerifyOutcome> {
  const proofFile = Bun.file(options.proofPath);
  const harFile = Bun.file(options.harPath);
  if (!(await proofFile.exists())) {
    return {
      kind: "failed",
      signal: "F402_HAR_PROOF_MISSING",
      detail: { proofPath: options.proofPath },
    };
  }
  if (!(await harFile.exists())) {
    return {
      kind: "failed",
      signal: "F402_HAR_FILE_MISSING",
      detail: { harPath: options.harPath },
    };
  }

  const proofRaw: unknown = await proofFile.json();
  const proofParsed = parseHarRedactionProofDocument(proofRaw);
  if ("kind" in proofParsed && proofParsed.kind === "failed") {
    return {
      ...proofParsed,
      detail: { ...proofParsed.detail, proofPath: options.proofPath },
    };
  }
  const proof = proofParsed as HarRedactionProof;
  const harText = await harFile.text();

  const liveHash = await sha256HexText(harText);
  if (liveHash !== proof.harSha256) {
    return {
      kind: "failed",
      signal: "F402_HAR_PROOF_HASH_MISMATCH",
      detail: { expected: proof.harSha256, live: liveHash },
    };
  }

  try {
    assertRedactedCaptureSweep(harText);
  } catch {
    return {
      kind: "failed",
      signal: "F402_HAR_SWEEP_FAILED",
      detail: { harPath: options.harPath },
    };
  }

  if (options.requireListAgents !== false && !proof.listAgentsCaptured) {
    return {
      kind: "failed",
      signal: "F402_HAR_MISSING_LIST_AGENTS",
      detail: {},
    };
  }

  return { kind: "ok" };
}
