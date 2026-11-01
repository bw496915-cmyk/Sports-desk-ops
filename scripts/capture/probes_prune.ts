#!/usr/bin/env bun
/**
 * @file scripts/capture/probes_prune.ts
 * @description Prune probe runs, keeping recent ones and the newest success per operation.
 *
 *   bun run probes:prune --dry-run
 *   bun run probes:prune --keep 3
 *
 * Never touches operations that have no 2xx anywhere: their runs are only kept by recency, so a run of
 * failures does not become permanent evidence by accident.
 */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../../lib/cli_args.ts";
import { type ProbeRun, planRetention } from "../../lib/probe_retention.ts";

const HELP = `
probes:prune — delete superseded probe runs

Options:
  --dir <path>   Probe root (default: scratch/f402-probes)
  --keep <n>     Always keep the newest n runs (default: 5)
  --dry-run      Print the plan; delete nothing
  -h, --help     This text

Examples:
  bun run probes:prune --dry-run
  bun run probes:prune --keep 3
  bun run probes:prune --dir scratch/f402-probes --keep 1

Keeps the newest n runs plus the newest run with a 2xx for each operation.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2), {
  valueFlags: ["--dir", "--keep"],
});
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const root = flagValue(parsed, "--dir", "scratch/f402-probes");
const keep = Math.max(0, Number(flagValue(parsed, "--keep", "5")) || 0);
const dryRun = hasFlag(parsed, "--dry-run");

const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
const runIds = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const runs: ProbeRun[] = [];
for (const id of runIds) {
  const dir = join(root, id);
  const operations: Array<{ operation: string; status: number }> = [];
  for await (const rel of new Bun.Glob("*.json").scan({
    cwd: dir,
    onlyFiles: true,
  })) {
    if (rel === "run.json") continue;
    const record = (await Bun.file(join(dir, rel))
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    const result = record?.["result"] as Record<string, unknown> | undefined;
    if (record === null || result === undefined) continue;
    const operation = record["operation"];
    const status = result["status"];
    if (typeof operation === "string" && typeof status === "number") {
      operations.push({ operation, status });
    }
  }
  runs.push({ id, operations });
}

if (runs.length === 0) {
  console.error(`probes:prune: no runs under ${root}`);
  process.exit(0);
}

const plan = planRetention(runs, { keep });

if (dryRun) {
  console.error(
    `probes:prune: ${runs.length} run(s), keep ${plan.keep.length}, remove ${plan.remove.length}`,
  );
  for (const id of plan.keep) console.log(`keep    ${id}`);
  for (const id of plan.remove) console.log(`remove  ${id}`);
  process.exit(0);
}

for (const id of plan.remove) {
  await rm(join(root, id), { recursive: true, force: true });
}
console.error(
  `probes:prune: kept ${plan.keep.length}/${runs.length} run(s), removed ${plan.remove.length} from ${root}`,
);
