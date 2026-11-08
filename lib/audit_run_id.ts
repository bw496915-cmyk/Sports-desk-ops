import {
  isoDateTimeUtc,
  type IsoDateTimeUtc,
} from "../design/domain-branded-types.ts";

/** Append-only batch marker (CLI may override with --run-id). */
export type AuditRunId = string & { readonly __auditRunId: unique symbol };

export function auditRunId(
  value: string = typeof Bun !== "undefined" &&
  typeof Bun.randomUUIDv7 === "function"
    ? Bun.randomUUIDv7()
    : crypto.randomUUID(),
): AuditRunId {
  return value as AuditRunId;
}

export type { IsoDateTimeUtc };

/** Validated tx_time / run_at for append-only SQLite rows. */
export function auditRunAt(
  value: string = new Date().toISOString(),
): IsoDateTimeUtc {
  return isoDateTimeUtc(value);
}
