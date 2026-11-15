import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  MAX_LIMIT,
  ToolError,
  querySnapshot,
  type ProfileField,
  type ProfileRecord,
} from "../../lib/profile_query_tools.ts";

const NUM_RUNS = (() => {
  const raw = Number(process.env.FAST_CHECK_NUM_RUNS);
  return Number.isInteger(raw) && raw > 0 ? raw : 100;
})();

const seed = Number(process.env.FAST_CHECK_SEED);
if (process.env.FAST_CHECK_SEED !== undefined && Number.isInteger(seed)) {
  fc.configureGlobal({ seed });
}

const FIELDS: readonly ProfileField[] = ["clv", "vol", "sharp"];
const isSentinel = (profile: ProfileRecord): boolean =>
  profile.id.startsWith("SYNTH_");

const valueArbitrary = fc.oneof(
  fc.constantFrom(0, -1, 1, 2.5, -2.5),
  fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
);

const profileArbitrary: fc.Arbitrary<ProfileRecord> = fc
  .record({
    id: fc
      .tuple(fc.boolean(), fc.integer({ min: 0, max: 999 }))
      .map(([synthetic, n]) => `${synthetic ? "SYNTH_" : ""}P${n}`),
    vol: valueArbitrary,
    clv: valueArbitrary,
    sharp: valueArbitrary,
    flags: fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
  })
  .map((profile) =>
    Object.freeze({ ...profile, flags: Object.freeze([...profile.flags]) }),
  );

const snapshotArbitrary = fc.uniqueArray(profileArbitrary, {
  selector: (profile) => profile.id,
  maxLength: 40,
});

/** Straightforward model of the contract, written again over the generated snapshot. */
function reference(
  snapshot: readonly ProfileRecord[],
  field: ProfileField,
  includeSentinels: boolean,
  limit: number,
): readonly {
  id: string;
  value: number;
  flags: readonly string[];
  sentinel: boolean;
}[] {
  const rows = snapshot
    .filter((profile) => includeSentinels || !isSentinel(profile))
    .map((profile) => ({
      id: profile.id,
      value: profile[field],
      flags: [...profile.flags],
      sentinel: isSentinel(profile),
    }));
  rows.sort((left, right) => {
    if (left.value !== right.value) return right.value - left.value;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return rows.slice(0, Math.min(limit, MAX_LIMIT));
}

describe("querySnapshot over generated snapshots", () => {
  test("matches the reference model for arbitrary data", () => {
    fc.assert(
      fc.property(
        snapshotArbitrary,
        fc.constantFrom(...FIELDS),
        fc.integer({ min: 1, max: MAX_LIMIT + 1 }),
        fc.boolean(),
        (snapshot, field, limit, includeSentinels) => {
          const result = querySnapshot(snapshot, {
            field,
            limit,
            includeSentinels,
          });
          const expected = reference(snapshot, field, includeSentinels, limit);
          expect(result.field).toBe(field);
          expect(result.rows).toEqual(expected);
          expect(result.truncated).toBe(limit > MAX_LIMIT);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("never mutates the input snapshot and freezes its own result", () => {
    fc.assert(
      fc.property(snapshotArbitrary, (snapshot) => {
        const before = snapshot.map((profile) => ({
          ...profile,
          flags: [...profile.flags],
        }));
        const result = querySnapshot(snapshot, { field: "clv", limit: 10 });
        expect(snapshot).toEqual(before);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.rows)).toBe(true);
        for (const row of result.rows) expect(Object.isFrozen(row)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("empty and all-sentinel snapshots degrade honestly", () => {
    expect(querySnapshot([], { field: "sharp" })).toEqual({
      field: "sharp",
      rows: [],
      truncated: false,
    });
    const syntheticOnly = [
      { id: "SYNTH_A", vol: 1, clv: 2, sharp: 3, flags: [] },
    ] as const;
    expect(querySnapshot(syntheticOnly, { field: "vol" }).rows).toEqual([]);
    expect(
      querySnapshot(syntheticOnly, { field: "vol", includeSentinels: true })
        .rows,
    ).toHaveLength(1);
  });

  test("argument validation is independent of the snapshot", () => {
    const snapshot = [
      { id: "A", vol: 1, clv: 2, sharp: 3, flags: [] },
    ] as const;
    for (const field of ["__proto__", "constructor", "toString", "", " "]) {
      expect(() => querySnapshot(snapshot, { field })).toThrow(ToolError);
    }
    for (const limit of [0, -1, 1.5, Number.NaN, Infinity, "5"]) {
      expect(() => querySnapshot(snapshot, { field: "clv", limit })).toThrow(
        ToolError,
      );
    }
  });
});
