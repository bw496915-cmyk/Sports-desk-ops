/**
 * @file lib/append_only_ledger.ts
 * @description Hash-chained append-only ledger for the desk's domain events.
 *
 * Design decisions, deliberately not the defaults:
 *
 *  - `seq` is a dense `bigint` (`1n, 2n, 3n…`), not a UUID. A ledger needs a
 *    gapless, replayable order; a sparse identifier cannot prove that no entry
 *    was dropped. `verify()` relies on it.
 *  - `eventId` is a UUIDv7 (`Bun.randomUUIDv7`). Sortable, collision-resistant,
 *    and no `Math.random()`: it exists so an entry can be cited externally, not
 *    so it can order the log.
 *  - `hash` chains every entry to its predecessor (`prevHash`). Mutating any
 *    field of any entry breaks `verify()` from that entry onward, which is what
 *    makes the log tamper-evident rather than merely append-only by convention.
 *  - The clock and the id generator are injectable so a replay produces
 *    byte-identical entries. Production uses `Date.now` and `Bun.randomUUIDv7`.
 *
 * Storage is in-memory. Persistence (JSONL / R2 / SQLite) is deliberately out
 * of scope here: the chain and its verification are the contract, and a
 * persistence layer must preserve both.
 */

import { createHash } from "node:crypto";

/** Payloads are plain records so `canonicalize` can order their keys. */
export interface LedgerPayload {
  readonly [key: string]: unknown;
}

export interface LedgerEntry<T extends LedgerPayload = LedgerPayload> {
  /** Dense position in the log, starting at `1n`. */
  readonly seq: bigint;
  /** UUIDv7, assigned once on append. External citation key, never ordering. */
  readonly eventId: string;
  /** Hash of the previous entry, or `GENESIS_HASH` for the first. */
  readonly prevHash: string;
  /** SHA-256 over `prevHash` and the canonical form of the entry body. */
  readonly hash: string;
  readonly timestampMs: number;
  /** Caller-supplied dedupe key; a second append with it is rejected. */
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly payload: T;
}

export interface AppendInput<T extends LedgerPayload = LedgerPayload> {
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: T;
  /**
   * Optimistic concurrency: the seq the caller believes is the current head
   * (`0n` for an empty ledger). A mismatch means another writer moved first.
   */
  readonly expectedSeq?: bigint;
}

export interface LedgerOptions {
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable id source; defaults to `Bun.randomUUIDv7`. */
  readonly nextEventId?: () => string;
}

export const GENESIS_HASH = "0".repeat(64);

/** Base class so a caller can catch the whole family with one `instanceof`. */
export class LedgerError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export class ErrInvalidEntry extends LedgerError {
  constructor(message: string) {
    super("ErrInvalidEntry", message);
  }
}

export class ErrDuplicateUpdate extends LedgerError {
  constructor(message: string) {
    super("ErrDuplicateUpdate", message);
  }
}

export class ErrStaleUpdate extends LedgerError {
  constructor(message: string) {
    super("ErrStaleUpdate", message);
  }
}

export class ErrReconciliationMismatch extends LedgerError {
  constructor(message: string) {
    super("ErrReconciliationMismatch", message);
  }
}

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped,
 * `bigint` tagged. Two payloads that are deeply equal serialize identically,
 * so the hash depends on content and not on insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new ErrInvalidEntry(
          `non-finite number in payload: ${String(value)}`,
        );
      }
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return `{"$bigint":${JSON.stringify(value.toString())}}`;
    case "undefined":
      return "null";
    case "object":
      break;
    default:
      throw new ErrInvalidEntry(`unsupported payload type: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const members = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`,
  );
  return `{${members.join(",")}}`;
}

function hashOf(prevHash: string, body: unknown): string {
  return createHash("sha256")
    .update(prevHash)
    .update("\n")
    .update(canonicalize(body))
    .digest("hex");
}

export class AppendOnlyLedger<T extends LedgerPayload = LedgerPayload> {
  readonly #entries: LedgerEntry<T>[] = [];
  readonly #keys = new Set<string>();
  readonly #now: () => number;
  readonly #nextEventId: () => string;

  constructor(options: LedgerOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#nextEventId = options.nextEventId ?? (() => Bun.randomUUIDv7());
  }

  get size(): number {
    return this.#entries.length;
  }

  /** The last entry, or `null` while the ledger is empty. */
  get head(): LedgerEntry<T> | null {
    return this.#entries.at(-1) ?? null;
  }

  /** Hash the next entry will chain to. */
  get headHash(): string {
    return this.#entries.at(-1)?.hash ?? GENESIS_HASH;
  }

  /**
   * Read-only view of the log. It is the live array, not a copy: mutating it
   * corrupts the chain, and `verify()` is what catches that.
   */
  entries(): readonly LedgerEntry<T>[] {
    return this.#entries;
  }

  append(input: AppendInput<T>): LedgerEntry<T> {
    if (
      typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.length === 0
    ) {
      throw new ErrInvalidEntry("idempotencyKey must be a non-empty string");
    }
    if (typeof input.kind !== "string" || input.kind.length === 0) {
      throw new ErrInvalidEntry("kind must be a non-empty string");
    }
    if (this.#keys.has(input.idempotencyKey)) {
      throw new ErrDuplicateUpdate(
        `idempotencyKey already present: ${input.idempotencyKey}`,
      );
    }

    const last = this.#entries.at(-1);
    const headSeq = last?.seq ?? 0n;
    if (input.expectedSeq !== undefined && input.expectedSeq !== headSeq) {
      throw new ErrStaleUpdate(
        `expected seq ${input.expectedSeq}, head is ${headSeq}`,
      );
    }

    const seq = headSeq + 1n;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const timestampMs = this.#now();
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
      throw new ErrInvalidEntry(
        `clock returned a non-safe timestamp: ${String(timestampMs)}`,
      );
    }

    const body = {
      seq,
      eventId: this.#nextEventId(),
      prevHash,
      timestampMs,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      payload: input.payload,
    };
    const entry: LedgerEntry<T> = { ...body, hash: hashOf(prevHash, body) };

    this.#entries.push(entry);
    this.#keys.add(input.idempotencyKey);
    return entry;
  }

  /**
   * Walks the chain and throws on the first inconsistency: a seq gap, a broken
   * link, or a recomputed hash that no longer matches. O(n) over the log.
   */
  verify(): true {
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1n;
    for (let index = 0; index < this.#entries.length; index += 1) {
      const entry = this.#entries[index]!;
      if (entry.seq !== expectedSeq) {
        throw new ErrReconciliationMismatch(
          `entry ${index}: seq ${entry.seq} is not ${expectedSeq}`,
        );
      }
      if (entry.prevHash !== prevHash) {
        throw new ErrReconciliationMismatch(
          `entry ${index}: prevHash does not chain to the previous entry`,
        );
      }
      const recomputed = hashOf(entry.prevHash, {
        seq: entry.seq,
        eventId: entry.eventId,
        prevHash: entry.prevHash,
        timestampMs: entry.timestampMs,
        idempotencyKey: entry.idempotencyKey,
        kind: entry.kind,
        payload: entry.payload,
      });
      if (recomputed !== entry.hash) {
        throw new ErrReconciliationMismatch(
          `entry ${index}: hash does not match its content`,
        );
      }
      prevHash = entry.hash;
      expectedSeq += 1n;
    }
    return true;
  }
}
