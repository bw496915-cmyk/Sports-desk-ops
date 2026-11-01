/**
 * Bun 1.4 `Bun.cron` helpers — OS-level Workers shape vs in-process callbacks.
 *
 * **Platforms:** crontab (Linux), launchd (macOS), Task Scheduler (Windows).
 *
 * **Three entry points:**
 * - `await Bun.cron(path, schedule, title)` — OS job; worker exports
 *   `default { scheduled(controller) }` (Cloudflare Cron Triggers shape:
 *   `controller.cron`, `controller.scheduledTime`, `controller.type`).
 * - `Bun.cron(schedule, handler, { tz? })` — in-process on the event loop; returns a
 *   `CronJob` (`job.cron`, `ref`/`unref`, `stop`, `[Symbol.dispose]`). Jobs never
 *   overlap (next fire after handler + Promise settle). CronJob handle: `.cron`, `.ref()` /
 *   `.unref()`, `.stop()`, `[Symbol.dispose]` — see {@link BUN_CRON_IN_PROCESS_HANDLE_EXAMPLE}.
 *   {@link startInProcessCron} returns the same handle; daemons use
 *   {@link wireInProcessCronLifecycle} (`ref` + SIGINT/SIGTERM).
 * - `Bun.cron.parse(expression, from?, { tz? })` — next matching `Date` in local time by
 *   default, or `{ tz: "IANA" }`; `null` if no match within 8 years; invalid `from` outside
 *   the ECMAScript Date range throws `TypeError`.
 *
 * **Syntax:** standard 5-field cron, named days/months, nicknames (`@daily`, …). #26999
 *
 * @see https://bun.com/docs/runtime/cron
 * @see lib/bun_cron.test.ts
 * @see docs/runbooks/os_bun_cron_integration_guide.md
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

/** Workers Cron Triggers export shape for OS-level jobs. */
export type CronScheduledWorker = {
  scheduled(controller: Bun.CronController): void | Promise<void>;
};

export interface CronSchedulePreview {
  readonly schedule: string;
  readonly tz: string | undefined;
  readonly next: Date;
}

export interface StartInProcessCronOptions {
  readonly tz?: string;
  /**
   * When `false`, calls `job.unref()` so a short-lived host process may exit without waiting
   * on the schedule. Default keeps the Bun default (`ref` — process stays alive).
   */
  readonly keepAlive?: boolean;
}

/** Verbatim Bun docs — {@link startInProcessCron} returns this same `CronJob` handle. */
export const BUN_CRON_IN_PROCESS_HANDLE_EXAMPLE =
  `using job = Bun.cron("*/5 * * * *", async () => {
  await cleanupTempFiles();
});
job.cron; // "*/5 * * * *"
job.unref(); // allow process exit
job.stop(); // cancel (or let \`using\` dispose)` as const;

export function startInProcessCron(
  schedule: string,
  handler: () => void | Promise<void>,
  options?: StartInProcessCronOptions,
): InProcessCronJob {
  const tz = options?.tz?.trim();
  const job =
    tz !== undefined && tz !== ""
      ? Bun.cron(schedule, handler, { tz })
      : Bun.cron(schedule, handler);
  if (options?.keepAlive === false) {
    job.unref();
  }
  return job;
}

export function parseCronScheduleOrNull(
  schedule: string,
  options?: { readonly tz?: string; readonly from?: Date | number },
): Date | null {
  const tz = options?.tz?.trim();
  const from = options?.from ?? new Date();
  return tz !== undefined && tz !== ""
    ? Bun.cron.parse(schedule, from, { tz })
    : Bun.cron.parse(schedule, from);
}

/** Next fire time; throws if expression/`from` is invalid or parse returns null. */
export function parseCronSchedule(
  schedule: string,
  options?: { readonly tz?: string; readonly from?: Date | number },
): Date {
  const next = parseCronScheduleOrNull(schedule, options);
  if (next === null || !(next instanceof Date)) {
    throw new Error(`invalid cron schedule: ${JSON.stringify(schedule)}`);
  }
  return next;
}

export function previewCronSchedule(
  schedule: string,
  options?: { readonly tz?: string; readonly from?: Date | number },
): CronSchedulePreview {
  const tzRaw = options?.tz?.trim();
  const tz = tzRaw !== undefined && tzRaw !== "" ? tzRaw : undefined;
  const next = parseCronSchedule(schedule, { tz, from: options?.from });
  return { schedule, tz, next };
}

/** One-line operator hint: schedule, optional tz, next fire ISO time. */
export function formatCronScheduleLine(preview: CronSchedulePreview): string {
  const tzSuffix = preview.tz ? ` (${preview.tz})` : "";
  return `scheduled "${preview.schedule}"${tzSuffix} · next ${preview.next.toISOString()}`;
}

/**
 * OS-level registration. Refuses `{ tz }` — crontab/launchd/Task Scheduler have no IANA pin in
 * Bun's path overload (use in-process `startInProcessCron` for explicit zones).
 */
export async function installOsCronJob(options: {
  readonly workerImportMetaUrl: string;
  readonly schedule: string;
  readonly title: string;
  readonly tz?: string;
}): Promise<void> {
  const tz = options.tz?.trim();
  if (tz !== undefined && tz !== "") {
    throw new Error(
      `OS-level Bun.cron cannot pin timezone (got ${JSON.stringify(tz)})`,
    );
  }
  await Bun.cron(
    osCronWorkerPath(options.workerImportMetaUrl),
    options.schedule,
    options.title,
  );
}

export async function removeOsCronJob(title: string): Promise<void> {
  await Bun.cron.remove(title);
}

/** Keep process alive; stop job and exit on SIGINT/SIGTERM (daemon CLIs). */
export function wireInProcessCronLifecycle(
  job: InProcessCronJob,
  options?: {
    readonly onShutdown?: (signal: NodeJS.Signals) => void;
    readonly exitCode?: number;
  },
): void {
  job.ref();
  const stop = (signal: NodeJS.Signals): void => {
    options?.onShutdown?.(signal);
    job.stop();
    process.exit(options?.exitCode ?? 0);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}
