#!/usr/bin/env bun
/**
 * @file scripts/artifacts_cron.ts
 * @description In-process scheduler for artifact regeneration (the P2.3 host).
 *
 *   bun run artifacts:cron --print-schedule
 *   bun run artifacts:cron --run-once
 *   bun run artifacts:cron                      # daily at 06:00 local
 *   bun run artifacts:cron --history 10
 *
 * Default mode is `--offline`, which requires the cached CFB event index and the bridge capture to
 * already exist. `--mode live` fetches. A run appends one JSON line to the journal; `--history` reads
 * it back with Bun.JSONL, which tolerates a partially written final line.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  formatRun,
  parseCronJournal,
  type CronRun,
} from "../lib/cron_journal.ts";

function flag(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1]! : fallback;
}

const args = process.argv.slice(2);
const schedule = flag(
  args,
  "--schedule",
  process.env.ARTIFACTS_CRON ?? "0 6 * * *",
);
const mode = flag(args, "--mode", "offline");
const journal = flag(args, "--journal", "scratch/artifacts-cron.jsonl");
const historyArg = flag(args, "--history", "");
const printSchedule = args.includes("--print-schedule");
const runOnce = args.includes("--run-once");

if (mode !== "offline" && mode !== "live") {
  console.error(`artifacts:cron: --mode must be offline|live (got ${mode})`);
  process.exit(2);
}

const nextFire = Bun.cron.parse(schedule);
if (nextFire === null || !(nextFire instanceof Date)) {
  console.error(`artifacts:cron: invalid schedule "${schedule}"`);
  process.exit(2);
}

if (printSchedule) {
  console.log(`schedule: ${schedule}`);
  console.log(`next fire: ${nextFire.toISOString()} (${nextFire.toString()})`);
  console.log(`mode: ${mode} · journal: ${journal}`);
  process.exit(0);
}

if (historyArg !== "") {
  const limit = Math.max(1, Number(historyArg) || 10);
  const file = Bun.file(journal);
  if (!(await file.exists())) {
    console.error(`artifacts:cron: no journal at ${journal}`);
    process.exit(2);
  }
  const runs = parseCronJournal(await file.text());
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
  await mkdir(join(journal, ".."), { recursive: true });
  await appendFile(journal, `${JSON.stringify(run)}\n`, "utf8");
  console.error(`artifacts:cron: ${formatRun(run)}`);
}

if (runOnce) {
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
