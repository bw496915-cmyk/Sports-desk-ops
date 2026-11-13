/**
 * @file tests/append_only_ledger.test.ts
 * @description Contract tests for the hash-chained append-only ledger: dense
 * seq ordering, idempotency, optimistic concurrency, and tamper detection.
 */
import { describe, expect, test } from "bun:test";
import {
  AppendOnlyLedger,
  ErrDuplicateUpdate,
  ErrInvalidEntry,
  ErrReconciliationMismatch,
  ErrStaleUpdate,
  GENESIS_HASH,
  canonicalize,
} from "../lib/append_only_ledger.ts";

type StakePayload = { amountCents: number; wagerId: string };

const CLOCK = 1_700_000_000_000;

function deterministicLedger(): AppendOnlyLedger<StakePayload> {
  let n = 0;
  return new AppendOnlyLedger<StakePayload>({
    now: () => CLOCK,
    nextEventId: () => {
      n += 1;
      return `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
    },
  });
}

describe("append and chain", () => {
  test("assigns dense seq values and links each entry to the previous hash", () => {
    const ledger = deterministicLedger();
    const first = ledger.append({
      kind: "wager.accepted",
      idempotencyKey: "w-1",
      payload: { amountCents: 500, wagerId: "w-1" },
    });
    const second = ledger.append({
      kind: "wager.settled",
      idempotencyKey: "w-1-settle",
      payload: { amountCents: 500, wagerId: "w-1" },
    });

    expect(first.seq).toBe(1n);
    expect(second.seq).toBe(2n);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(ledger.headHash).toBe(second.hash);
    expect(ledger.verify()).toBe(true);
  });

  test("a deterministic clock and id source reproduce identical hashes", () => {
    const build = (): string => {
      const ledger = deterministicLedger();
      ledger.append({
        kind: "wager.accepted",
        idempotencyKey: "w-1",
        payload: { amountCents: 500, wagerId: "w-1" },
      });
      return ledger.head!.hash;
    };
    expect(build()).toBe(build());
  });

  test("eventId is a UUIDv7 and strictly increasing across appends", () => {
    const ledger = new AppendOnlyLedger<StakePayload>();
    const pattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      const entry = ledger.append({
        kind: "tick",
        idempotencyKey: `t-${i}`,
        payload: { amountCents: i, wagerId: `w-${i}` },
      });
      expect(entry.eventId).toMatch(pattern);
      ids.push(entry.eventId);
    }
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });
});

describe("rejections", () => {
  test("duplicate idempotencyKey is rejected", () => {
    const ledger = deterministicLedger();
    const input = {
      kind: "wager.accepted",
      idempotencyKey: "w-1",
      payload: { amountCents: 500, wagerId: "w-1" },
    };
    ledger.append(input);
    expect(() => ledger.append(input)).toThrow(ErrDuplicateUpdate);
    expect(ledger.size).toBe(1);
  });

  test("stale expectedSeq is rejected before anything is written", () => {
    const ledger = deterministicLedger();
    ledger.append({
      kind: "wager.accepted",
      idempotencyKey: "w-1",
      payload: { amountCents: 500, wagerId: "w-1" },
    });
    expect(() =>
      ledger.append({
        kind: "wager.accepted",
        idempotencyKey: "w-2",
        payload: { amountCents: 100, wagerId: "w-2" },
        expectedSeq: 0n,
      }),
    ).toThrow(ErrStaleUpdate);
    expect(ledger.size).toBe(1);
  });

  test("matching expectedSeq is accepted", () => {
    const ledger = deterministicLedger();
    ledger.append({
      kind: "wager.accepted",
      idempotencyKey: "w-1",
      payload: { amountCents: 500, wagerId: "w-1" },
    });
    const entry = ledger.append({
      kind: "wager.settled",
      idempotencyKey: "w-2",
      payload: { amountCents: 500, wagerId: "w-1" },
      expectedSeq: 1n,
    });
    expect(entry.seq).toBe(2n);
  });

  test("empty idempotencyKey and kind are rejected", () => {
    const ledger = deterministicLedger();
    expect(() =>
      ledger.append({
        kind: "wager.accepted",
        idempotencyKey: "",
        payload: { amountCents: 1, wagerId: "w" },
      }),
    ).toThrow(ErrInvalidEntry);
    expect(() =>
      ledger.append({
        kind: "",
        idempotencyKey: "k",
        payload: { amountCents: 1, wagerId: "w" },
      }),
    ).toThrow(ErrInvalidEntry);
  });

  test("payloads with non-finite numbers are rejected", () => {
    const ledger = deterministicLedger();
    expect(() =>
      ledger.append({
        kind: "wager.accepted",
        idempotencyKey: "nan",
        payload: { amountCents: Number.NaN, wagerId: "w" },
      }),
    ).toThrow(ErrInvalidEntry);
  });
});

describe("tamper detection", () => {
  function three(): AppendOnlyLedger<StakePayload> {
    const ledger = deterministicLedger();
    for (let i = 1; i <= 3; i += 1) {
      ledger.append({
        kind: "wager.accepted",
        idempotencyKey: `w-${i}`,
        payload: { amountCents: i * 100, wagerId: `w-${i}` },
      });
    }
    return ledger;
  }

  test("mutating a payload breaks verification at that entry", () => {
    const ledger = three();
    const log = ledger.entries() as Array<ReturnType<typeof ledger.append>>;
    log[1] = { ...log[1]!, payload: { amountCents: 999_999, wagerId: "w-2" } };
    expect(() => ledger.verify()).toThrow(ErrReconciliationMismatch);
    try {
      ledger.verify();
    } catch (error) {
      expect((error as Error).message).toContain("entry 1");
    }
  });

  test("breaking the prevHash link is detected", () => {
    const ledger = three();
    const log = ledger.entries() as Array<ReturnType<typeof ledger.append>>;
    log[2] = { ...log[2]!, prevHash: GENESIS_HASH };
    expect(() => ledger.verify()).toThrow(ErrReconciliationMismatch);
  });

  test("a seq gap is detected", () => {
    const ledger = three();
    const log = ledger.entries() as Array<ReturnType<typeof ledger.append>>;
    log[2] = { ...log[2]!, seq: 7n };
    expect(() => ledger.verify()).toThrow(/seq 7 is not 3/);
  });

  test("an untouched ledger verifies", () => {
    expect(three().verify()).toBe(true);
  });
});

describe("canonicalize", () => {
  test("is independent of object key insertion order", () => {
    const a = { b: 2, a: 1, nested: { z: true, y: [1, "two"] } };
    const b = { nested: { y: [1, "two"], z: true }, a: 1, b: 2 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  test("tags bigint values and drops undefined members", () => {
    expect(canonicalize({ n: 10n })).toBe('{"n":{"$bigint":"10"}}');
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("rejects unsupported types", () => {
    expect(() => canonicalize({ fn: () => 1 })).toThrow(ErrInvalidEntry);
  });
});
