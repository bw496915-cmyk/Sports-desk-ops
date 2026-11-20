#!/usr/bin/env bun
import { spawnSyncBounded } from "../lib/spawn_sync_bounded.ts";
if (Bun.env.PRETEST_SKIP?.trim() === "1") process.exit(0);
const proc = spawnSyncBounded(
  ["bun", "run", "verification/manager-boot-oracle/run-slice-guard.ts"],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(proc.exitCode ?? 1);
