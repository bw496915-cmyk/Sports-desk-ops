import { describe, expect, test } from "bun:test";

import { runGuestCell } from "../../lib/quickjs_code_mode.ts";
import { assertMatchesOracle } from "./oracle.ts";
import { BANNED_GUEST_GLOBALS, probeGuestGlobals } from "./guest_probe.ts";

describe("QuickJS guest boundary", () => {
  test("guest globalThis does not expose host capabilities", async () => {
    const names = await probeGuestGlobals();
    expect(Array.isArray(names)).toBe(true);
    for (const banned of BANNED_GUEST_GLOBALS) {
      expect(names).not.toContain(banned);
    }
    // A real realm still has the language intrinsics and the tools bridge.
    expect(names).toContain("Object");
    expect(names).toContain("tools");
  });

  test("typeof host identifiers is undefined inside the guest", async () => {
    const kinds = await runGuestCell(
      "return [typeof Bun, typeof process, typeof require, typeof module]",
    );
    expect(kinds).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  });

  test("a guest cell can query profiles through the bridge", async () => {
    const args = { field: "sharp", limit: 500 };
    const guest = await runGuestCell(
      `return tools.query_profiles(${JSON.stringify(args)})`,
    );
    assertMatchesOracle(guest, args);
  });

  test("a guest cell sees the same frozen profile as the host", async () => {
    const guest = await runGuestCell(
      'return tools.get_profile({ id: "BGD101" })',
    );
    expect(guest).toMatchObject({ id: "BGD101", vol: 1 });
    expect((guest as { flags?: unknown }).flags).toBeArray();
  });

  test("host tool errors surface as guest exceptions", async () => {
    await expect(
      runGuestCell('return tools.query_profiles({ field: "toString" })'),
    ).rejects.toThrow(/field required/);
  });
});
