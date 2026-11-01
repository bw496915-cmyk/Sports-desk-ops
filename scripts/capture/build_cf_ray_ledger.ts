#!/usr/bin/env bun
/**
 * Aggregate cfRay + tier signals from scratch f402-probes (PII-safe ops only).
 */
import { Glob } from "bun";
import { join } from "node:path";
import { deriveTier } from "./tier.ts";
import { captureRecordFromProbeScratch } from "./promote_probe_from_file.ts";
import { isProbeReadOnlyConfirmed, PROBE_OPS } from "../../lib/f402_probe.ts";

const root = join(import.meta.dir, "../..");
const outPath = join(
  root,
  "docs/evidence/captures/pending-500s/cf_ray_ledger.json",
);

const opByName = new Map(PROBE_OPS.map((op) => [op.operation, op]));

interface LedgerRow {
  capturedAt: string;
  operation: string;
  prefix: string;
  backend: string;
  status: number;
  bytes: number;
  cfRay: string | null;
  derivedTier: string;
  sessionIsAgent: boolean;
  requestBodyTokenInjected: boolean;
  scratchFile: string;
}

const rows: LedgerRow[] = [];
const glob = new Glob("scratch/f402-probes/**/*.json");

for await (const rel of glob.scan({ cwd: root, absolute: true })) {
  if (!rel.endsWith(".json") || rel.endsWith("run.json")) continue;
  let raw: Record<string, unknown>;
  try {
    raw = (await Bun.file(rel).json()) as Record<string, unknown>;
  } catch {
    continue;
  }
  if (raw["kind"] !== "webview-probe") continue;
  const opName = String(raw["operation"] ?? "");
  const op = opByName.get(opName);
  if (op === undefined || !isProbeReadOnlyConfirmed(op)) continue;
  if (raw["readOnlyConfirmed"] !== true) continue;
  const result = raw["result"] as Record<string, unknown> | undefined;
  const status = Number(result?.["status"] ?? 0);
  const bytes = Number(result?.["bytes"] ?? 0);
  const cfRay =
    typeof result?.["cfRay"] === "string"
      ? result["cfRay"]
      : typeof raw["cfRay"] === "string"
        ? raw["cfRay"]
        : null;
  if (cfRay === null && status < 500) continue;

  let derivedTier = "—";
  try {
    const record = captureRecordFromProbeScratch(raw, { probePath: rel });
    derivedTier = deriveTier(record);
  } catch {
    derivedTier = status === 500 && bytes === 0 && cfRay ? "C-edge?" : "—";
  }

  const url = String(raw["url"] ?? "");
  let prefix = "";
  try {
    prefix = new URL(url).pathname.replace(/\/[^/]+$/, "");
  } catch {
    prefix = "";
  }

  rows.push({
    capturedAt: String(raw["capturedAt"] ?? ""),
    operation: opName,
    prefix,
    backend: String(raw["backend"] ?? ""),
    status,
    bytes,
    cfRay,
    derivedTier,
    sessionIsAgent: raw["sessionIsAgent"] === true,
    requestBodyTokenInjected: raw["requestBodyTokenInjected"] === true,
    scratchFile: rel.replace(`${root}/`, ""),
  });
}

rows.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

const document = {
  schemaVersion: 1,
  kind: "cf-ray-ledger",
  generatedAt: new Date().toISOString(),
  rowCount: rows.length,
  rows,
};

await Bun.write(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.error(`build_cf_ray_ledger: wrote ${rows.length} rows -> ${outPath}`);
