/**
 * @file lib/probe_retention.ts
 * @description Decide which probe runs to keep.
 *
 * Probe runs accumulated while the request envelope was being worked out: 18 directories, 52 files, and
 * up to ten attempts at the same operation. Retention keeps two things and deletes the rest:
 *
 *  - the newest N runs, so recent failures are still inspectable;
 *  - the newest run that produced a 2xx for each operation, so the evidence for a working call never
 *    disappears because it is old.
 */

export interface RunOperation {
  readonly operation: string;
  readonly status: number;
}

export interface ProbeRun {
  /** Directory name, `YYYY-MM-DDTHH-MM-SS-mmmZ`; sorts chronologically. */
  readonly id: string;
  readonly operations: readonly RunOperation[];
}

export interface RetentionPlan {
  readonly keep: readonly string[];
  readonly remove: readonly string[];
}

export function planRetention(
  runs: readonly ProbeRun[],
  options: { keep: number },
): RetentionPlan {
  const ordered = [...runs].sort((a, b) => a.id.localeCompare(b.id));
  const keep = new Set<string>();

  // `slice(-0)` is `slice(0)`, which keeps every run; guard the zero case explicitly.
  const keepCount = Math.max(0, options.keep);
  if (keepCount > 0) {
    for (const run of ordered.slice(-keepCount)) keep.add(run.id);
  }

  // Newest successful run per operation.
  const seen = new Set<string>();
  for (const run of [...ordered].reverse()) {
    for (const op of run.operations) {
      if (op.status < 200 || op.status >= 300) continue;
      if (seen.has(op.operation)) continue;
      seen.add(op.operation);
      keep.add(run.id);
    }
  }

  return {
    keep: [...keep].sort(),
    remove: ordered.map((run) => run.id).filter((id) => !keep.has(id)),
  };
}
