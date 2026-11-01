#!/usr/bin/env bun
/**
 * Ingest getDeletedTransactionHistory JSON (`{ LIST: [...] }`).
 *
 *   bun run capture:ingest-deleted-transactions --in response.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseDeletedTransactionHistoryEnvelope,
  probeCustomerForHistory,
  summarizeDeletedTransactionHistory,
} from "../../lib/f402_deleted_transaction_history.ts";

function usage(): void {
  console.error(`Usage:
  ingest_deleted_transaction_history.ts [--in path] [--out path] [--out-summary path]

Defaults:
  --out          scratch/f402-deleted-transactions/envelope.json
  --out-summary  scratch/f402-deleted-transactions/summary.json
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
  let outPath = "scratch/f402-deleted-transactions/envelope.json";
  let outSummary = "scratch/f402-deleted-transactions/summary.json";

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--in") inPath = args[++i];
    else if (a === "--out") outPath = args[i + 1] ?? outPath;
    else if (a === "--out-summary") outSummary = args[i + 1] ?? outSummary;
  }

  const envelope = parseDeletedTransactionHistoryEnvelope(
    JSON.parse(await readInput(inPath)),
  );
  const summary = summarizeDeletedTransactionHistory(envelope);
  const probeCustomer = probeCustomerForHistory(envelope);

  for (const p of [outPath, outSummary]) {
    await mkdir(dirname(resolve(p)), { recursive: true });
  }

  await writeFile(
    resolve(outPath),
    `${JSON.stringify(envelope, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(outSummary),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        source: "getDeletedTransactionHistory",
        probeCustomer,
        ...summary,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        rowCount: summary.rowCount,
        customerIds: summary.customerIds,
        probeCustomer,
        documentNumbersHead: summary.documentNumbers.slice(0, 5),
        outPath: resolve(outPath),
        outSummary: resolve(outSummary),
      },
      null,
      2,
    ),
  );
}

await main();
