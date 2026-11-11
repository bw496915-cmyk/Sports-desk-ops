#!/usr/bin/env bun
/** Delegates to scratch check workshop (includes sportsdesk typecheck). */
import { join } from "node:path";

const scratch = join(import.meta.dir, "../../scratch");
const proc = Bun.spawnSync({
  cmd: ["bun", "scripts/bun-check-workshop.ts"],
  cwd: scratch,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    CHECK_WORKSHOP_REQUIRED: "1",
    CHECK_WORKSHOP_SPORTSDESK: "1",
  },
});
process.exit(proc.exitCode ?? 1);
