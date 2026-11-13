/**
 * @file tests/rot_mapper.test.ts
 * @description Contract tests for the ROT resolver: an unmapped pair is
 * quarantined and thrown, never coerced onto a neighbouring canonical ROT.
 */
import { describe, expect, test } from "bun:test";
import {
  ErrInvalidRotMapping,
  ErrROTUnmapped,
  ROTMapper,
  type RotMapping,
} from "../lib/rot_mapper.ts";

const MAPPINGS: readonly RotMapping[] = [
  {
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    sourceRot: "S",
    canonicalRot: "straight",
  },
  {
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    sourceRot: "P",
    canonicalRot: "parlay",
  },
  {
    originDomainId: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    sourceRot: "S",
    canonicalRot: "gs.straight",
  },
];

const FIXED = new Date("2026-11-12T00:00:00.000Z");

function deterministicMapper(): ROTMapper {
  let n = 0;
  return new ROTMapper(MAPPINGS, {
    now: () => FIXED,
    nextQuarantineId: () => {
      n += 1;
      return `Q-test-${n}`;
    },
  });
}

describe("resolve", () => {
  test("returns the canonical ROT for a mapped pair", () => {
    const mapper = new ROTMapper(MAPPINGS);
    expect(mapper.resolve("ORIGIN_SPORTSBOOK_FANTASY402", "S", "w-1")).toEqual({
      canonicalRot: "straight",
      originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
      sourceRot: "S",
    });
  });

  test("the same source token maps differently per origin domain", () => {
    const mapper = new ROTMapper(MAPPINGS);
    const f402 = mapper.resolve("ORIGIN_SPORTSBOOK_FANTASY402", "S", "w-1");
    const gslive = mapper.resolve(
      "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
      "S",
      "w-2",
    );
    expect(f402.canonicalRot).toBe("straight");
    expect(gslive.canonicalRot).toBe("gs.straight");
    expect(mapper.quarantined()).toHaveLength(0);
  });
});

describe("quarantine on an unmapped pair", () => {
  test("throws ErrROTUnmapped carrying the origin, source and wager", () => {
    const mapper = deterministicMapper();
    try {
      mapper.resolve("ORIGIN_EXCHANGE_KALSHI_REGULATED", "X", "w-9");
      throw new Error("expected ErrROTUnmapped");
    } catch (error) {
      expect(error).toBeInstanceOf(ErrROTUnmapped);
      const unmapped = error as ErrROTUnmapped;
      expect(unmapped.originDomainId).toBe("ORIGIN_EXCHANGE_KALSHI_REGULATED");
      expect(unmapped.sourceRot).toBe("X");
      expect(unmapped.sourceWagerId).toBe("w-9");
      expect(unmapped.quarantineId).toBe("Q-test-1");
    }
  });

  test("records the quarantine with the injected clock and id", () => {
    const mapper = deterministicMapper();
    expect(() =>
      mapper.resolve("ORIGIN_EXCHANGE_KALSHI_REGULATED", "X", "w-9"),
    ).toThrow(ErrROTUnmapped);

    const [record] = mapper.quarantined();
    expect(record).toEqual({
      quarantineId: "Q-test-1",
      originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
      sourceWagerId: "w-9",
      sourceRot: "X",
      timestamp: FIXED,
      reason:
        "Source ROT mapped incorrectly or missing resolution on domain ORIGIN_EXCHANGE_KALSHI_REGULATED",
    });
  });

  test("every miss is recorded, in order", () => {
    const mapper = deterministicMapper();
    for (const rot of ["X", "Y", "X"]) {
      expect(() =>
        mapper.resolve("ORIGIN_SPORTSBOOK_FANTASY402", rot, `w-${rot}`),
      ).toThrow(ErrROTUnmapped);
    }
    expect(mapper.quarantined().map((q) => q.quarantineId)).toEqual([
      "Q-test-1",
      "Q-test-2",
      "Q-test-3",
    ]);
    // The mapper does not learn from a miss.
    expect(mapper.size).toBe(MAPPINGS.length);
  });

  test("default quarantine ids are Q-prefixed UUIDv7 values", () => {
    const mapper = new ROTMapper(MAPPINGS);
    try {
      mapper.resolve("ORIGIN_SPORTSBOOK_FANTASY402", "?", "w-1");
    } catch (error) {
      const id = (error as ErrROTUnmapped).quarantineId;
      expect(id).toMatch(
        /^Q-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe("mapping validation", () => {
  test("duplicate (origin, source) pairs are rejected at construction", () => {
    expect(
      () =>
        new ROTMapper([
          { originDomainId: "A", sourceRot: "S", canonicalRot: "one" },
          { originDomainId: "A", sourceRot: "S", canonicalRot: "two" },
        ]),
    ).toThrow(ErrInvalidRotMapping);
  });

  test("empty origin, source or canonical values are rejected", () => {
    expect(
      () =>
        new ROTMapper([
          { originDomainId: "", sourceRot: "S", canonicalRot: "x" },
        ]),
    ).toThrow(ErrInvalidRotMapping);
    expect(
      () =>
        new ROTMapper([
          { originDomainId: "A", sourceRot: "", canonicalRot: "x" },
        ]),
    ).toThrow(ErrInvalidRotMapping);
    expect(
      () =>
        new ROTMapper([
          { originDomainId: "A", sourceRot: "S", canonicalRot: "" },
        ]),
    ).toThrow(ErrInvalidRotMapping);
  });
});
