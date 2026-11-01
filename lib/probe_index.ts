/**
 * @file lib/probe_index.ts
 * @description Queryable index of probe records, backed by SQLite through `Bun.SQL`.
 *
 * Probe output is one JSON file per operation per run, which is good evidence and bad for questions
 * like "has getGrading ever returned 200?". The index keeps that answer one query away and is
 * rebuilt idempotently: the file path is the primary key.
 */

export interface ProbeRecord {
  readonly path: string;
  readonly operation: string;
  readonly status: number;
  readonly verdict: string;
  readonly bytes: number;
  readonly authMode: string;
  readonly capturedAt: string;
}

export interface ProbeRow extends ProbeRecord {
  readonly at: string;
}

export type ProbeDatabase = InstanceType<typeof Bun.SQL>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS probes (
  path TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  status INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  auth_mode TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS probes_operation ON probes(operation, captured_at);
`;

export function openProbeIndex(url = "sqlite://:memory:"): ProbeDatabase {
  return new Bun.SQL(url);
}

export async function ensureProbeSchema(db: ProbeDatabase): Promise<void> {
  for (const statement of SCHEMA.split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await db.unsafe(statement);
  }
}

export async function indexProbeRecords(
  db: ProbeDatabase,
  records: readonly ProbeRecord[],
): Promise<number> {
  let written = 0;
  for (const record of records) {
    await db`
      INSERT INTO probes (path, operation, status, verdict, bytes, auth_mode, captured_at)
      VALUES (${record.path}, ${record.operation}, ${record.status}, ${record.verdict},
              ${record.bytes}, ${record.authMode}, ${record.capturedAt})
      ON CONFLICT(path) DO UPDATE SET
        operation = excluded.operation,
        status = excluded.status,
        verdict = excluded.verdict,
        bytes = excluded.bytes,
        auth_mode = excluded.auth_mode,
        captured_at = excluded.captured_at
    `;
    written += 1;
  }
  return written;
}

/** Latest attempt per operation, newest first. */
export async function latestPerOperation(
  db: ProbeDatabase,
): Promise<ProbeRow[]> {
  const rows = await db`
    SELECT p.path, p.operation, p.status, p.verdict, p.bytes, p.auth_mode, p.captured_at
    FROM probes p
    WHERE p.captured_at = (
      SELECT MAX(q.captured_at) FROM probes q WHERE q.operation = p.operation
    )
    ORDER BY p.operation
  `;
  return (rows as Record<string, unknown>[]).map((row) => ({
    path: String(row["path"]),
    operation: String(row["operation"]),
    status: Number(row["status"]),
    verdict: String(row["verdict"]),
    bytes: Number(row["bytes"]),
    authMode: String(row["auth_mode"]),
    capturedAt: String(row["captured_at"]),
    at: String(row["captured_at"]),
  }));
}

/**
 * History per operation.
 *
 * Deliberately not a single "best" verdict: a run can be 401 (edge refused) and a later run 400
 * (route reached, parameters wrong). Collapsing those into one label hides the progress.
 */
export async function bestPerOperation(db: ProbeDatabase): Promise<
  Array<{
    operation: string;
    attempts: number;
    everExists: boolean;
    everDenied: boolean;
    lastStatus: number;
  }>
> {
  const rows = (await db`
    SELECT operation,
           COUNT(*) AS attempts,
           SUM(CASE WHEN verdict = 'exists' THEN 1 ELSE 0 END) AS exists_count,
           SUM(CASE WHEN verdict = 'denied' THEN 1 ELSE 0 END) AS denied_count
    FROM probes
    GROUP BY operation
    ORDER BY operation
  `) as Record<string, unknown>[];

  const latest = new Map(
    (await latestPerOperation(db)).map((row) => [row.operation, row.status]),
  );
  return rows.map((row) => {
    const operation = String(row["operation"]);
    return {
      operation,
      attempts: Number(row["attempts"]),
      everExists: Number(row["exists_count"]) > 0,
      everDenied: Number(row["denied_count"]) > 0,
      lastStatus: latest.get(operation) ?? 0,
    };
  });
}

/**
 * Drop index rows whose file no longer exists.
 *
 * The index was append-only, so pruning runs left the counts and `best` view reporting attempts that had
 * been deleted from disk.
 */
export async function pruneMissingProbes(
  db: ProbeDatabase,
  paths: ReadonlySet<string>,
): Promise<number> {
  const rows = (await db`SELECT path FROM probes`) as Record<string, unknown>[];
  let removed = 0;
  for (const row of rows) {
    const path = String(row["path"]);
    if (paths.has(path)) continue;
    await db`DELETE FROM probes WHERE path = ${path}`;
    removed += 1;
  }
  return removed;
}
