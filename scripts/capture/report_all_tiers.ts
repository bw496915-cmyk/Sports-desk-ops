#!/usr/bin/env bun
/**
 * Tier report for main capture store + pending-500 edge-store.
 */
import { join } from "node:path";
import { deriveTier } from "./tier.ts";
import { loadCaptureStore } from "./recorder.ts";

const root = join(import.meta.dir, "../..");
const stores = [
  { label: "captures", path: join(root, "docs/evidence/captures") },
  {
    label: "edge-store",
    path: join(root, "docs/evidence/captures/pending-500s/edge-store"),
  },
] as const;

let failed = false;
for (const store of stores) {
  console.error(`\n=== ${store.label} (${store.path}) ===`);
  try {
    const verified = await loadCaptureStore(store.path);
    const byTier = new Map<string, number>();
    for (const { record, entry } of verified.captures) {
      const tier = entry.derivedTier ?? deriveTier(record);
      byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
      const cf = entry.provenance.cfRay;
      if (tier === "C-edge" || cf) {
        console.log(
          `${tier.padEnd(8)} ${record.operation.path.padEnd(42)} status=${entry.responseStatus ?? "?"} cfRay=${cf ?? "—"}`,
        );
      }
    }
    for (const [tier, count] of [...byTier.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      console.error(`  ${tier}: ${count}`);
    }
  } catch (e) {
    failed = true;
    console.error(`  skip: ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(failed ? 1 : 0);
