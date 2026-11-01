#!/usr/bin/env bun
/**
 * Ingest `getCustomerAdmin` JSON (`{ LIST: [...] }`), redact Password fields, emit summary.
 *
 *   bun run capture:ingest-customer-admin-list --in response.json
 *   curl ... | bun run capture:ingest-customer-admin-list
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  parseCustomerAdminListEnvelope,
  redactCustomerAdminListEnvelope,
  summarizeCustomerAdminList,
} from "../../lib/f402_customer_admin_list.ts";

function usage(): void {
  console.error(`Usage:
  ingest_customer_admin_list.ts [--in path] [--out-redacted path] [--out-summary path]

Defaults:
  --out-redacted  scratch/f402-customer-admin/list.redacted.json
  --out-summary   scratch/f402-customer-admin/summary.json
`);
}

async function readInput(inPath: string | undefined): Promise<string> {
  if (inPath) return await Bun.file(inPath).text();
  return await Bun.stdin.text();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    process.exit(0);
  }

  let inPath: string | undefined;
  let outRedacted = "scratch/f402-customer-admin/list.redacted.json";
  let outSummary = "scratch/f402-customer-admin/summary.json";

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--in") inPath = args[++i];
    else if (a === "--out-redacted") outRedacted = args[++i] ?? outRedacted;
    else if (a === "--out-summary") outSummary = args[++i] ?? outSummary;
  }

  const raw = JSON.parse(await readInput(inPath)) as unknown;
  const envelope = parseCustomerAdminListEnvelope(raw);
  const summary = summarizeCustomerAdminList(envelope);
  const redacted = redactCustomerAdminListEnvelope(envelope);

  await mkdir(dirname(outRedacted), { recursive: true });
  await mkdir(dirname(outSummary), { recursive: true });
  await writeFile(outRedacted, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  await writeFile(
    outSummary,
    `${JSON.stringify({ schemaVersion: 1, kind: "customer-admin-list-summary", ...summary }, null, 2)}\n`,
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        rowCount: summary.rowCount,
        agentIds: summary.agentIds,
        rowsWithPending: summary.rowsWithPending,
        outRedacted,
        outSummary,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
