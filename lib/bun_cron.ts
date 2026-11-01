/**
 * Bun 1.4 `Bun.cron` helpers — OS-level Workers shape vs in-process callbacks.
 * @see https://bun.com/docs/runtime/cron
 */

import { fileURLToPath } from "node:url";

/** True when Bun invokes a worker via `bun run --cron-title=… --cron-period=…`. */
export function isBunOsCronInvocation(
  argv: readonly string[] = process.argv,
): boolean {
  return argv.some((arg) => arg.startsWith("--cron-"));
}

/** Absolute script path for `await Bun.cron(path, schedule, title)` (launchd/crontab). */
export function osCronWorkerPath(importMetaUrl: string): string {
  return fileURLToPath(importMetaUrl);
}

export type InProcessCronJob = ReturnType<typeof Bun.cron>;

export function startInProcessCron(
  schedule: string,
  handler: () => void | Promise<void>,
  options?: { readonly tz?: string },
): InProcessCronJob {
  const tz = options?.tz?.trim();
  if (tz !== undefined && tz !== "") {
    return Bun.cron(schedule, handler, { tz });
  }
  return Bun.cron(schedule, handler);
}

export function parseCronSchedule(
  schedule: string,
  options?: { readonly tz?: string; readonly from?: Date | number },
): Date {
  const tz = options?.tz?.trim();
  const from = options?.from ?? new Date();
  const next =
    tz !== undefined && tz !== ""
      ? Bun.cron.parse(schedule, from, { tz })
      : Bun.cron.parse(schedule, from);
  if (next === null || !(next instanceof Date)) {
    throw new Error(`invalid cron schedule: ${JSON.stringify(schedule)}`);
  }
  return next;
}
