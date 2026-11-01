#!/usr/bin/env bun
/**
 * @file scripts/capture/probe_index.ts
 * @description Index probe records into SQLite with Bun.SQL and query them.
 *
 *   bun run probes:index                 # index scratch/f402-probes → scratch/probes.sqlite
 *   bun run probes:index list            # latest attempt per operation
 *   bun run probes:index best            # best verdict ever seen per operation
 *   bun run probes:index list --json
 *
 * The files stay the evidence; this is the query layer.
 */

import { Glob } from "bun";
import { join } from "node:path";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../../lib/cli_args.ts";
import { probeVerdict } from "../../lib/f402_probe.ts";
import {
  type ProbeRecord,
  bestPerOperation,
  ensureProbeSchema,
  indexProbeRecords,
  latestPerOperation,
  openProbeIndex,
  pruneMissingProbes,
} from "../../lib/probe_index.ts";

const HELP = `
probes:index — index probe JSON into SQLite and query it

Usage:
  bun run probes:index [index] [dir]     Index every *.json under dir
  bun run probes:index list              Latest attempt per operation
  bun run probes:index best              Best verdict ever seen per operation

Options:
  --db <path>        SQLite file (default: scratch/probes.sqlite)
  --operation <op>   Filter list output
  --json             Machine-readable output
  -h, --help         This text

Examples:
  bun run probes:index
  bun run probes:index list --operation getGrading
  bun run probes:index best --json
`.trim();

const VALUE_FLAGS = ["--db", "--operation"] as const;

const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: VALUE_FLAGS });
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const command = parsed.positionals[0] ?? "index";
const dbPath = flagValue(parsed, "--db", "scratch/probes.sqlite");
const json = hasFlag(parsed, "--json");
const operationFilter = flagValue(parsed, "--operation", "");

const db = openProbeIndex(`sqlite://${dbPath}`);
try {
  await ensureProbeSchema(db);

  if (command === "index") {
    const dir = parsed.positionals[1] ?? "scratch/f402-probes";
    const records: ProbeRecord[] = [];
    for await (const rel of new Glob("**/*.json").scan({
      cwd: dir,
      onlyFiles: true,
    })) {
      const baseName = rel.split("/").pop() ?? rel;
      if (baseName === "run.json" || baseName.startsWith("_")) continue;
      const path = join(dir, rel);
      const raw = (await Bun.file(path).json()) as Record<string, unknown>;
      if (raw["kind"] === "probe-run") continue;
      const result = raw["result"] as Record<string, unknown> | undefined;
      const operation = raw["operation"];
      const capturedAt = raw["capturedAt"];
      const authMode = raw["authMode"];
      if (
        typeof operation !== "string" ||
        typeof capturedAt !== "string" ||
        result === undefined ||
        typeof result["status"] !== "number"
      ) {
        console.error(`probes:index: skipping malformed ${path}`);
        continue;
      }
      records.push({
        path,
        operation,
        status: Number(result["status"]),
        verdict: String(
          result["verdict"] ?? probeVerdict(Number(result["status"])),
        ),
        bytes: Number(result["bytes"] ?? 0),
        authMode: typeof authMode === "string" ? authMode : "unknown",
        capturedAt,
      });
    }
    const written = await indexProbeRecords(db, records);
    const removed = await pruneMissingProbes(
      db,
      new Set(records.map((record) => record.path)),
    );
    console.error(
      `probes:index: indexed ${written} record(s) from ${dir} into ${dbPath}` +
        (removed > 0 ? `, removed ${removed} stale row(s)` : ""),
    );
  } else if (command === "list") {
    const rows = (await latestPerOperation(db)).filter(
      (row) => operationFilter === "" || row.operation === operationFilter,
    );
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      for (const row of rows) {
        console.log(
          `${row.operation.padEnd(30)} ${String(row.status).padEnd(5)} ${row.verdict.padEnd(8)} ${row.bytes} B  ${row.authMode}`,
        );
      }
    }
  } else if (command === "best") {
    const rows = await bestPerOperation(db);
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      for (const row of rows) {
        const seen = row.everExists
          ? "200 seen"
          : row.everDenied
            ? "401 seen"
            : "no success";
        console.log(
          `${row.operation.padEnd(30)} ${seen.padEnd(9)} ${row.attempts} attempt(s)  last ${row.lastStatus}`,
        );
      }
    }
  } else {
    console.error(
      `probes:index: unknown command "${command}" (index|list|best).`,
    );
    console.error("  bun run probes:index best");
    process.exit(2);
  }
} finally {
  await db.close();
}
