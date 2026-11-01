import { captureRecipeFingerprint } from "./provenance_helpers.ts";
import { deriveTierWithReason, type EvidenceTier } from "./tier.ts";
import type { CaptureRecord } from "./types.ts";

export function manifestProjectionForRecord(record: CaptureRecord): {
  derivedTier: EvidenceTier;
  derivedTierReason: string;
  captureRecipeSha256?: string;
} {
  const { tier: derivedTier, reason: derivedTierReason } =
    deriveTierWithReason(record);
  const captureRecipeSha256 = captureRecipeFingerprint(record.provenance);
  return captureRecipeSha256 === undefined
    ? { derivedTier, derivedTierReason }
    : { derivedTier, derivedTierReason, captureRecipeSha256 };
}
