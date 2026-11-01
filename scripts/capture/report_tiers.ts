#!/usr/bin/env bun
/**
 * Print derived evidence tiers and explicit derivation reasons from a capture store manifest.
 */
import { deriveTierWithReason } from "./tier.ts";
import { loadCaptureStore } from "./recorder.ts";

const root = process.argv[2] ?? "docs/evidence/captures";

let verified;
try {
  verified = await loadCaptureStore(root);
} catch (e) {
  console.error(
    `capture:report-tiers: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
}
const byTier = new Map<string, number>();
for (const { record, entry } of verified.captures) {
  const derived = deriveTierWithReason(record);
  const tier = entry.derivedTier ?? derived.tier;
  const reason = entry.derivedTierReason ?? derived.reason;
  byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
  const cf = entry.provenance.cfRay;
  const edge = tier === "C-edge";
  if (edge || cf || tier !== "A") {
    console.log(
      `${tier.padEnd(8)} ${record.operation.path.padEnd(42)} status=${entry.responseStatus ?? "?"} cfRay=${cf ?? "—"} reason=${reason}`,
    );
  }
}
console.error("\ncapture:report-tiers summary:");
for (const [tier, count] of [...byTier.entries()].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  console.error(`  ${tier}: ${count}`);
}
