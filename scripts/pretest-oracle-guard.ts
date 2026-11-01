#!/usr/bin/env bun
if (Bun.env.PRETEST_SKIP?.trim() === "1") process.exit(0);
const proc = Bun.spawnSync(
  ["bun", "run", "verification/manager-boot-oracle/run-slice-guard.ts"],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(proc.exitCode ?? 1);
