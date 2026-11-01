import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseTeaserProfileEnvelope,
  summarizeTeaserProfile,
  trimPaddedCustomerId,
} from "./f402_teaser_profile.ts";

const fixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-teaser-profile-billy666.json",
);

describe("getTeaserProfile LIST envelope", () => {
  test("parses five teaser rows for BILLY666", () => {
    const env = parseTeaserProfileEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    expect(env.LIST).toHaveLength(5);
    expect(trimPaddedCustomerId(env.LIST[0]?.CustomerID)).toBe("BILLY666");
    expect(env.LIST[0]?.info?.MaxPicks).toBe(6);
    expect(env.LIST[3]?.info?.TeaserTies).toBe(2);
  });

  test("summarize collects trimmed teaser names and pick ranges", () => {
    const env = parseTeaserProfileEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    const summary = summarizeTeaserProfile(env);
    expect(summary.rowCount).toBe(5);
    expect(summary.customerIds).toEqual(["BILLY666"]);
    expect(summary.teaserNames[0]).toBe("Basic +½ - 6T");
    expect(summary.pickRanges[3]).toEqual({ min: 3, max: 3 });
  });

  test("rejects missing LIST", () => {
    expect(() => parseTeaserProfileEnvelope({})).toThrow("LIST");
  });
});
