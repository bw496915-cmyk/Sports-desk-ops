#!/usr/bin/env bun
/**
 * @file scripts/artifacts_cron.ts
 * @description In-process scheduler for artifact regeneration (the P2.3 host).
 *
 * Default mode is `--offline`, which requires the cached CFB event index and the bridge capture.
 * `--mode live` fetches. Each run appends one JSON line to the journal; `--history` reads it back
 * with Bun.JSONL, which tolerates a partially written final line.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  formatRun,
  parseCronJournal,
  type CronRun,
} from "../lib/cron_journal.ts";

const VALUE_FLAGS = ["--schedule", "--mode", "--journal", "--history"] as const;

const HELP = `
artifacts:cron — rebuild the value artifacts on a schedule

Options:
  --schedule <expr>   Cron expression (default: ARTIFACTS_CRON or "0 6 * * *")
  --mode <m>          offline (default) or live
  --journal <path>    Run journal (default: scratch/artifacts-cron.jsonl)
  --history <n>       Print the last n runs and exit
  --print-schedule    Show the next fire time and exit
  --run-once          Rebuild now, then exit
  -h, --help          This text

Examples:
  bun run artifacts:cron --print-schedule
  bun run artifacts:cron --run-once
  bun run artifacts:cron --history 20
  ARTIFACTS_CRON="0 */6 * * *" bun run artifacts:cron

A run is: generate_value_artifacts [--offline] → artifacts_lock --update. It never deploys.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: VALUE_FLAGS });
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const schedule = flagValue(
  parsed,
  "--schedule",
  process.env.ARTIFACTS_CRON ?? "0 6 * * *",
);
const mode = flagValue(parsed, "--mode", "offline");
const journal = flagValue(parsed, "--journal", "scratch/artifacts-cron.jsonl");
const historyArg = flagValue(parsed, "--history", "");

if (mode !== "offline" && mode !== "live") {
  console.error(`artifacts:cron: --mode must be offline|live (got ${mode}).`);
  console.error("  bun run artifacts:cron --mode live");
  process.exit(2);
}

const nextFire = Bun.cron.parse(schedule);
if (nextFire === null || !(nextFire instanceof Date)) {
  console.error(`artifacts:cron: invalid schedule "${schedule}".`);
  console.error('  bun run artifacts:cron --schedule "0 6 * * *"');
  process.exit(2);
}

if (hasFlag(parsed, "--print-schedule")) {
  console.log(`schedule: ${schedule}`);
  console.log(`next fire: ${nextFire.toISOString()} (${nextFire.toString()})`);
  console.log(`mode: ${mode} · journal: ${journal}`);
  process.exit(0);
}

if (historyArg !== "") {
  const limit = Math.max(1, Number(historyArg) || 10);
  const file = Bun.file(journal);
  if (!(await file.exists())) {
    console.error(`artifacts:cron: no journal at ${journal}.`);
    console.error("  bun run artifacts:cron --run-once");
    process.exit(2);
  }
  const runs = parseCronJournal(await file.text());
  if (runs.length === 0)
    console.error(`artifacts:cron: journal ${journal} has no complete runs`);
  for (const run of runs.slice(-limit)) console.log(formatRun(run));
  process.exit(0);
}

async function rebuild(): Promise<CronRun> {
  const started = Date.now();
  const valueArgs = ["run", "scripts/generate_value_artifacts.ts"];
  if (mode === "offline") valueArgs.push("--offline");

  const value = Bun.spawnSync(["bun", ...valueArgs], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (value.exitCode === 0) {
    const lock = Bun.spawnSync(
      ["bun", "run", "scripts/artifacts_lock.ts", "--update"],
      {
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if (lock.exitCode !== 0) {
      return {
        at: new Date().toISOString(),
        ok: false,
        exitCode: lock.exitCode ?? 1,
        durationMs: Date.now() - started,
        mode,
      };
    }
  }

  return {
    at: new Date().toISOString(),
    ok: (value.exitCode ?? 1) === 0,
    exitCode: value.exitCode ?? 1,
    durationMs: Date.now() - started,
    mode,
  };
}

async function record(run: CronRun): Promise<void> {
  await mkdir(dirname(journal), { recursive: true });
  await appendFile(journal, `${JSON.stringify(run)}\n`, "utf8");
  console.error(`artifacts:cron: ${formatRun(run)}`);
}

if (hasFlag(parsed, "--run-once")) {
  await record(await rebuild());
  process.exit(0);
}

console.error(
  `artifacts:cron: scheduled "${schedule}" (next ${nextFire.toISOString()}) · mode ${mode}`,
);
const job = Bun.cron(schedule, async () => {
  await record(await rebuild());
});
job.ref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    job.stop();
    process.exit(0);
  });
}
