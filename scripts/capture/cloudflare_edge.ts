import type { CaptureProvenance } from "./types.ts";

/** True when empty-500 is more likely an edge drop than a serialized origin 500. */
export function isCloudflareEdgeDrop(provenance: CaptureProvenance): boolean {
  const body = provenance.body ?? "none";
  const edgeSignal =
    provenance.waf === "cloudflare" ||
    provenance.state?.challengePresent === true ||
    Boolean(provenance.cfRay?.length);
  if (!edgeSignal) return false;
  return body === "empty-500";
}
