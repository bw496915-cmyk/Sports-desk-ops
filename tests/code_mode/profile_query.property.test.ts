import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  isToolError,
  queryProfilesTool,
} from "../../lib/profile_query_tools.ts";
import { MAX_LIMIT, assertMatchesOracle } from "./oracle.ts";

const NUM_RUNS = (() => {
  const raw = Number(process.env.FAST_CHECK_NUM_RUNS);
  return Number.isInteger(raw) && raw > 0 ? raw : 100;
})();

const fieldArbitrary = fc.oneof(
  fc.constantFrom("clv", "vol", "sharp"),
  fc.string(),
  fc.constantFrom(
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "",
    " ",
  ),
);

const limitArbitrary = fc.oneof(
  fc.constantFrom(
    Number.NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    1,
    1.5,
    -1,
    MAX_LIMIT - 1,
    MAX_LIMIT,
    MAX_LIMIT + 1,
  ),
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.double(),
);

const includeArbitrary = fc.oneof(
  fc.boolean(),
  fc.constant(true),
  fc.anything(),
  fc.constant(Symbol("truthy")),
);

const runQuery = async (args: unknown): Promise<unknown> => {
  try {
    return await queryProfilesTool.execute(args);
  } catch (error) {
    return error;
  }
};

describe("query_profiles property oracle", () => {
  test("arbitrary arguments satisfy the frozen oracle", async () => {
    await fc.assert(
      fc.asyncProperty(
        fieldArbitrary,
        limitArbitrary,
        includeArbitrary,
        async (field, limit, includeSentinels) => {
          const args = { field, limit, includeSentinels };
          assertMatchesOracle(await runQuery(args), args);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("an omitted limit equals the default limit and ignores unrelated keys", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("clv", "vol", "sharp"),
        async (field) => {
          const base = await queryProfilesTool.execute({ field });
          const explicit = await queryProfilesTool.execute({
            field,
            limit: MAX_LIMIT,
          });
          const extras = await queryProfilesTool.execute({
            field,
            ignored: { nested: [1, 2, 3] },
            includeSentinels: false,
          });
          expect(explicit).toEqual(base);
          expect(extras).toEqual(base);
          expect(isToolError(base)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("sentinel rows appear only for includeSentinels === true", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("clv", "vol", "sharp"),
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.object(),
          fc.array(fc.anything()),
          fc.boolean(),
        ),
        async (field, includeSentinels) => {
          const result = await queryProfilesTool.execute({
            field,
            includeSentinels,
          });
          const expected = includeSentinels === true;
          expect(result.rows.some((row) => row.sentinel)).toBe(expected);
          expect(result.rows.every((row) => Number.isFinite(row.value))).toBe(
            true,
          );
          expect(result.rows.every((row) => Array.isArray(row.flags))).toBe(
            true,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
