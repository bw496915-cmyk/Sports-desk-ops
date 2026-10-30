/**
 * SportsDesk SQLite layer — **bun:sqlite only**.
 *
 * Do not route ingestion/bitemporal/trigger code through `Bun.SQL("sqlite://…")`:
 * that API lacks `fileControl`, sync `transaction()`, and engine-level triggers/hooks
 * used here. Cross-DB reads may use Bun.SQL elsewhere; never mix both on ingestion_trades.
 */

import { Database, constants } from "bun:sqlite";

/** Strict binding + exact integers (required for i64 sentinels and tx timestamps). */
export const SPORTSDESK_BUN_SQLITE_OPTIONS = {
  strict: true,
  safeIntegers: true,
} as const;

export type SportsdeskSqliteOptions = {
  readonly?: boolean;
};

export function openSportsdeskSqlite(
  path: string,
  options: SportsdeskSqliteOptions = {},
): Database {
  return new Database(path, {
    ...SPORTSDESK_BUN_SQLITE_OPTIONS,
    ...(options.readonly ? { readonly: true } : {}),
  });
}

export function openSportsdeskSqliteReadonly(path: string): Database {
  return openSportsdeskSqlite(path, { readonly: true });
}

/**
 * macOS persistent WAL leaves `-wal`/`-shm` after close. Run before archiving `.sqlite`.
 */
export function truncateWalAndDisablePersist(db: Database): void {
  db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  db.run("PRAGMA wal_checkpoint(TRUNCATE);");
}

/** Coerce bun:sqlite INTEGER (number | bigint with safeIntegers) to number. */
export function sqlInt(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

export function sqlIntOrNull(
  value: number | bigint | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "bigint" ? Number(value) : value;
}
