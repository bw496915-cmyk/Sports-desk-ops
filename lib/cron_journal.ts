/**
 * @file lib/cron_journal.ts
 * @description Journal for scheduled artifact rebuilds, read back with `Bun.JSONL`.
 *
 * Each run appends one line. `Bun.JSONL.parse` ignores an incomplete trailing value, which is what
 * makes a journal safe to read while a run is still writing.
 */

export interface CronRun {
  readonly at: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly mode: string;
}

export function parseCronJournal(text: string): CronRun[] {
  const rows = Bun.JSONL.parse(text);
  const runs: CronRun[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const candidate = row as Record<string, unknown>;
    const at = candidate["at"];
    const ok = candidate["ok"];
    const exitCode = candidate["exitCode"];
    const durationMs = candidate["durationMs"];
    const mode = candidate["mode"];
    if (
      typeof at !== "string" ||
      typeof ok !== "boolean" ||
      typeof exitCode !== "number" ||
      typeof durationMs !== "number" ||
      typeof mode !== "string"
    ) {
      continue;
    }
    runs.push({ at, ok, exitCode, durationMs, mode });
  }
  return runs;
}

export function formatRun(run: CronRun): string {
  const state = run.ok ? "ok" : `failed(${run.exitCode})`;
  return `${run.at}  ${run.mode.padEnd(7)} ${state.padEnd(14)} ${run.durationMs} ms`;
}
