import { describe, expect, test } from "bun:test";

import { diffExtractedSlicesAgainstPinnedManager } from "./f402_portal_oracle_slice.ts";

describe("manager-boot-oracle slice guard", () => {
  test("extracted/*.body.min.js matches re-slice from pinned manager.js", async () => {
    const mismatches = await diffExtractedSlicesAgainstPinnedManager();
    expect(mismatches).toEqual([]);
  });
});
