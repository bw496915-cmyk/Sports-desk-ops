#!/usr/bin/env bun
/**
 * Summarize graded-wager cfRay IDs for Cloudflare WAF / Security Events lookup (no secrets).
 */
import { join } from "node:path";

const ledgerPath =
  process.argv[2]?.trim() ||
  join(
    import.meta.dir,
    "../../docs/evidence/captures/pending-500s/cf_ray_ledger.json",
  );

const raw = (await Bun.file(ledgerPath).json()) as {
  rows?: Array<{
    operation?: string;
    status?: number;
    bytes?: number;
    cfRay?: string | null;
    derivedTier?: string;
    capturedAt?: string;
    backend?: string;
    sessionIsAgent?: boolean;
    reportCustomerContextApplied?: boolean;
  }>;
};

const rows = raw.rows ?? [];
const graded = rows.filter((r) => r.operation === "getGradedWagerByCustomer");

const byRay = new Map<
  string,
  { count: number; backends: Set<string>; tiers: Set<string> }
>();
for (const row of graded) {
  const ray = row.cfRay?.trim();
  if (!ray) continue;
  const cur = byRay.get(ray) ?? {
    count: 0,
    backends: new Set<string>(),
    tiers: new Set<string>(),
  };
  cur.count += 1;
  if (row.backend) cur.backends.add(row.backend);
  if (row.derivedTier) cur.tiers.add(row.derivedTier);
  byRay.set(ray, cur);
}

const outPath = join(
  import.meta.dir,
  "../../docs/evidence/captures/pending-500s/waf_correlation_brief.json",
);

const document = {
  schemaVersion: 1,
  kind: "waf-correlation-brief",
  generatedAt: new Date().toISOString(),
  sourceLedger: ledgerPath.replace(/.*\/sportsdesk-ops\//, ""),
  gradedProbeRows: graded.length,
  uniqueRays: [...byRay.entries()].map(([ray, meta]) => ({
    cfRay: ray,
    datacenter: ray.includes("-") ? ray.split("-").pop() : null,
    observations: meta.count,
    backends: [...meta.backends].sort(),
    tiers: [...meta.tiers].sort(),
  })),
  operatorSteps: [
    "Cloudflare Dashboard → Security → Events (or WAF) → filter by Ray ID",
    "Correlate empty HTTP 500 (0 B) + cfRay with Block/Challenge action vs Allow",
    "If Block: edge hypothesis confirmed; if Allow: pull origin error log for same timestamp",
  ],
};

await Bun.write(outPath, `${JSON.stringify(document, null, 2)}\n`);

console.error(
  `waf_ray_brief: ${graded.length} graded rows, ${byRay.size} unique Ray IDs`,
);
for (const [ray, meta] of byRay) {
  console.log(
    `${ray}  obs=${meta.count}  backends=${[...meta.backends].join(",")}`,
  );
}
console.error(`waf_ray_brief: wrote ${outPath}`);
