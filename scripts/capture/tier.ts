/**
 * @file scripts/capture/tier.ts
 * @description Pure evidence-tier derivation (with explicit audit reason) from the capture axes.
 *
 * Tier is a projection of the recorded axes, never a stored field. `deriveTierWithReason`
 * turns a capture record plus cross-record context into `{ tier, reason }` so "why is this
 * Tier C?" is answerable in one call and "this capture gained information" becomes a visible
 * diff in the derivation instead of a silent reclassification.
 *
 * Derivation rules (the only rules, each a one-line predicate):
 * 1. `body: "populated"` + `request` in {exact, minimal} + `mutation` known → **A**
 * 2. `body: "empty-envelope"` → **A-empty** (promoted, data unknown)
 * 3. `body: "template"` | `body: "populated-shell"` → **A-shell** (routing only, not data)
 * 4. Same operation on two prefixes with different results → **B** (contradicted)
 * 5. Cloudflare edge + `empty-500` → **C-edge** (check Cf-Ray in WAF logs, not origin first)
 * 6. `body` in {error-body, empty-500, none} (or populated without specific request/known mutation) → **C**
 * 7. `body: "error-body"` with a 4xx status and `mutation: "write"` → **D** (mutation rejected)
 * 8. Retired path → **E**
 */

import { isCloudflareEdgeDrop } from "./cloudflare_edge.ts";
import type {
  CaptureBodyVerdict,
  CaptureProvenance,
  CaptureRecord,
} from "./types.ts";

/** Ledger tier values; `A-empty`/`A-shell` are sub-tiers of A kept distinct so promoted-but-
 * unpopulated captures cannot be mistaken for populated ones. */
export type EvidenceTier =
  "A" | "A-empty" | "A-shell" | "B" | "C" | "C-edge" | "D" | "E";

export interface DeriveTierContext {
  /** True when the same operation was observed on two prefixes with different results. */
  contradicted?: boolean;
  /** True when the operation path has been retired from the surface. */
  retired?: boolean;
}

export interface TierDerivation {
  readonly tier: EvidenceTier;
  readonly reason: string;
}

function isMutationKnown(mutation: CaptureProvenance["mutation"]): boolean {
  return mutation !== undefined && mutation !== "unknown";
}

function isRequestSpecific(request: CaptureProvenance["request"]): boolean {
  return request === "exact" || request === "minimal";
}

/**
 * Derive both the ledger tier and the human/machine-auditable reason from the recorded axes.
 * Pure: no I/O, no clock, no globals.
 */
export function deriveTierWithReason(
  record: Pick<CaptureRecord, "provenance" | "response">,
  context: DeriveTierContext = {},
): TierDerivation {
  if (context.retired === true) {
    return {
      tier: "E",
      reason: "operation path is retired from the surface",
    };
  }
  if (context.contradicted === true) {
    return {
      tier: "B",
      reason:
        "same operation observed on two prefixes with contradicting results",
    };
  }

  const body: CaptureBodyVerdict = record.provenance.body ?? "none";
  const mutation = record.provenance.mutation;
  const request = record.provenance.request;

  if (body === "populated") {
    if (isMutationKnown(mutation) && isRequestSpecific(request)) {
      return {
        tier: "A",
        reason: `body is populated with ${request} request and ${mutation} mutation`,
      };
    }
    if (!isMutationKnown(mutation)) {
      return {
        tier: "C",
        reason: `body is populated but mutation is ${mutation ?? "unknown"}`,
      };
    }
    return {
      tier: "C",
      reason: `body is populated but request is ${request ?? "unspecified"} (requires exact or minimal)`,
    };
  }
  if (body === "populated-shell") {
    return {
      tier: "A-shell",
      reason:
        "body is populated-shell (server-rendered layout chrome/metadata, dynamic content unpopulated)",
    };
  }
  if (body === "empty-envelope") {
    return {
      tier: "A-empty",
      reason: "body is empty-envelope (routing confirmed, item rows absent)",
    };
  }
  if (body === "template") {
    return {
      tier: "A-shell",
      reason: "body is template (routing only, not data)",
    };
  }
  if (body === "error-body") {
    const status = record.response?.status ?? 0;
    if (
      status >= 400 &&
      status < 500 &&
      record.provenance.mutation === "write"
    ) {
      return {
        tier: "D",
        reason: `write mutation rejected with HTTP ${status} error-body`,
      };
    }
    return {
      tier: "C",
      reason: `body is error-body (HTTP ${status || "unknown"}) with mutation ${mutation ?? "unknown"}`,
    };
  }
  if (body === "empty-500") {
    if (isCloudflareEdgeDrop(record.provenance)) {
      return {
        tier: "C-edge",
        reason: `empty-500 at Cloudflare edge (cfRay=${record.provenance.cfRay ?? "challenge-script"})`,
      };
    }
    return {
      tier: "C",
      reason: "body is empty-500 with no edge signal (origin handler crash)",
    };
  }
  return {
    tier: "C",
    reason: "body is none (no response body text recorded)",
  };
}

/**
 * Derive the ledger tier from the recorded axes. Pure wrapper around `deriveTierWithReason`.
 */
export function deriveTier(
  record: Pick<CaptureRecord, "provenance" | "response">,
  context: DeriveTierContext = {},
): EvidenceTier {
  return deriveTierWithReason(record, context).tier;
}
