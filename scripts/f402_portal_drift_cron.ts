#!/usr/bin/env bun
/**
 * Always-on portal bundle drift signal via in-process Bun.cron.
 *
 *   bun run portal:drift:cron --watch
 *   F402_PORTAL_DRIFT_CRON="0 */6 * * *" bun run portal:drift:cron --watch
 *   F402_PORTAL_DRIFT_CRON_TZ=America/Chicago bun run portal:drift:cron --watch
 */
import { join } from "node:path";

import {
  previewCronSchedule,
  startInProcessCron,
  wireInProcessCronLifecycle,
} from "../lib/bun_cron.ts";
import {
  collectLivePortalArtifactDrift,
  emitPortalArtifactDriftSignal,
} from "../lib/f402_portal_drift_signal.ts";
import { loadManifestWithRuntime } from "../lib/f402_portal_runtime_pin.ts";

const schedule = Bun.env.F402_PORTAL_DRIFT_CRON?.trim() || "0 */6 * * *";
const tz = Bun.env.F402_PORTAL_DRIFT_CRON_TZ?.trim();

async function runDriftCheck(): Promise<void> {
  const manifest = await loadManifestWithRuntime();
  const bunPath = manifest.runtime?.bunExecutablePath ?? process.execPath;
  const proc = Bun.spawnSync(
    [bunPath, join(import.meta.dir, "verify/f402_portal_drift_once.ts")],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((proc.exitCode ?? 1) !== 0) {
    const details = await collectLivePortalArtifactDrift();
    if (details.length > 0) emitPortalArtifactDriftSignal(details);
  }
}

if (Bun.argv.includes("--run-once")) {
  await runDriftCheck();
  process.exit(0);
}

if (!Bun.argv.includes("--watch")) {
  console.log(
    `portal:drift:cron — use --watch or --run-once (schedule ${schedule})`,
  );
  process.exit(0);
}

process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({ signal: "F402_PORTAL_DRIFT_CRON_REJECTED", reason: String(reason) }),
  );
});

const manifest = await loadManifestWithRuntime();
const bunPath = manifest.runtime?.bunExecutablePath ?? process.execPath;

const preview = previewCronSchedule(
  schedule,
  tz !== undefined && tz !== "" ? { tz } : undefined,
);

const job = startInProcessCron(
  schedule,
  async () => {
    await runDriftCheck();
  },
  tz !== undefined && tz !== "" ? { tz } : undefined,
);

wireInProcessCronLifecycle(job, {
  onShutdown: (signal) => {
    console.error(`portal:drift:cron ${signal}; stopping cron job`);
  },
});

console.error(
  JSON.stringify({
    signal: "F402_PORTAL_DRIFT_CRON_WATCH",
    schedule: job.cron,
    tz: preview.tz ?? "local",
    nextFire: preview.next.toISOString(),
    bunPath,
  }),
);

await new Promise<void>(() => {});
