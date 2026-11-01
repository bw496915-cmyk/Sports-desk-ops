#!/usr/bin/env bun
/**
 * Read Manager deleted-transactions JSON (INFO.LIST), strip passwords, emit probe targets.
 *
 *   bun run scripts/capture/ingest_deleted_wager_list.ts < envelope.json
 *   bun run scripts/capture/ingest_deleted_wager_list.ts --in scratch/f402-deleted-wagers/envelope.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseDeletedWagerEnvelope,
  redactDeletedWagerEnvelope,
  targetsFromEnvelope,
} from "../../lib/f402_deleted_wager_list.ts";

function usage(): void {
  console.error(`Usage:
  ingest_deleted_wager_list.ts [--in path] [--out-redacted path] [--out-targets path]

Defaults:
  --out-redacted  scratch/f402-deleted-wagers/envelope.redacted.json
  --out-targets   scratch/f402-deleted-wagers/probe-targets.json
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
  let outRedacted = "scratch/f402-deleted-wagers/envelope.redacted.json";
  let outTargets = "scratch/f402-deleted-wagers/probe-targets.json";

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--in") inPath = args[++i];
    else if (a === "--out-redacted") outRedacted = args[i + 1] ?? outRedacted;
    else if (a === "--out-targets") outTargets = args[i + 1] ?? outTargets;
  }

  const text = await readInput(inPath);
  const envelope = parseDeletedWagerEnvelope(JSON.parse(text));
  const targets = targetsFromEnvelope(envelope);
  const redacted = redactDeletedWagerEnvelope(envelope);

  for (const p of [outRedacted, outTargets]) {
    await mkdir(dirname(resolve(p)), { recursive: true });
  }

  await writeFile(
    resolve(outRedacted),
    `${JSON.stringify(redacted, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(outTargets),
    `${JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), targets }, null, 2)}\n`,
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        legs: envelope.INFO.LIST.length,
        uniqueTickets: targets.length,
        outRedacted: resolve(outRedacted),
        outTargets: resolve(outTargets),
        topByWager: targets.slice(0, 5).map((t) => ({
          customerId: t.customerId,
          ticketNumber: t.ticketNumber,
          amountWagered: t.amountWagered,
        })),
      },
      null,
      2,
    ),
  );
}

await main();
