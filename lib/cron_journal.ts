/**
 * @file lib/cron_journal.ts
 * @description Journal for scheduled artifact rebuilds, read back with `Bun.JSONL`.
 *
 * Each run appends one line. Per `docs/runtime/jsonl.mdx`:
 * - `Bun.JSONL.parse(input)` throws a `SyntaxError` if the input contains invalid/incomplete JSON
 *   and zero values were parsed before the error (e.g. while the very first journal line is still
 *   being written).
 * - `Bun.JSONL.parseChunk(input)` never throws on invalid or incomplete trailing JSON: it returns
 *   `{ values, read, done, error }`, making it safe even on a half-written first line and supporting
 *   both `string` and `Uint8Array` (automatically skipping a leading UTF-8 BOM).
 */

export interface CronRun {
  readonly at: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly mode: string;
}

export interface CronJournalChunkResult {
  readonly runs: CronRun[];
  readonly read: number;
  readonly done: boolean;
  readonly hasPartialOrInvalidTail: boolean;
}

function toCronRuns(rows: readonly unknown[]): CronRun[] {
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

/**
 * Parse a JSONL journal (string or `Uint8Array`) using `Bun.JSONL.parseChunk` so even a
 * partially written first record never throws a `SyntaxError`.
 */
export function parseCronJournalChunk(
  input: string | Uint8Array,
): CronJournalChunkResult {
  const length = typeof input === "string" ? input.length : input.byteLength;
  if (length === 0) {
    return { runs: [], read: 0, done: true, hasPartialOrInvalidTail: false };
  }
  if (typeof Bun.JSONL?.parseChunk === "function") {
    const chunk =
      typeof input === "string"
        ? Bun.JSONL.parseChunk(input)
        : Bun.JSONL.parseChunk(input);
    return {
      runs: toCronRuns(chunk.values),
      read: chunk.read,
      done: chunk.done,
      hasPartialOrInvalidTail: !chunk.done || chunk.error !== null,
    };
  }
  try {
    const rows = Bun.JSONL.parse(input);
    return {
      runs: toCronRuns(rows),
      read: length,
      done: true,
      hasPartialOrInvalidTail: false,
    };
  } catch {
    return {
      runs: [],
      read: 0,
      done: false,
      hasPartialOrInvalidTail: true,
    };
  }
}

export function parseCronJournal(input: string | Uint8Array): CronRun[] {
  return parseCronJournalChunk(input).runs;
}

export function formatRun(run: CronRun): string {
  const state = run.ok ? "ok" : `failed(${run.exitCode})`;
  return `${run.at}  ${run.mode.padEnd(7)} ${state.padEnd(14)} ${run.durationMs} ms`;
}
