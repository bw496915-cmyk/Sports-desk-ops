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

describe("sandbox resource and isolation guarantees", () => {
  test("an infinite loop is interrupted by the timeout", async () => {
    await expect(
      runGuestCell("while (true) {}", { timeoutMs: 75 }),
    ).rejects.toThrow(/guest cell failed/);
  });

  test("the tool-call budget stops a runaway cell", async () => {
    await expect(
      runGuestCell(
        'for (let i = 0; i < 10; i += 1) tools.get_profile({ id: "BGD101" }); return "ok";',
        { maxToolCalls: 3 },
      ),
    ).rejects.toThrow(/ERR_CODE_MODE_MAX_CALLS/);
  });

  test("each cell gets a fresh realm", async () => {
    await runGuestCell("globalThis.__leak = 42; return 1");
    const leaked = await runGuestCell("return typeof globalThis.__leak");
    expect(leaked).toBe("undefined");
  });

  test("guest mutation of a tool result cannot reach the host snapshot", async () => {
    const before = await runGuestCell(
      'const p = tools.get_profile({ id: "BGD101" }); p.flags.push("hacked"); p.vol = -1; return p.flags.length;',
    );
    expect(before).toBe(2);
    const after = await runGuestCell(
      'return tools.get_profile({ id: "BGD101" })',
    );
    expect(after).toMatchObject({ id: "BGD101", vol: 1 });
    expect((after as { flags: string[] }).flags).not.toContain("hacked");
  });

  test("the Function constructor stays inside the guest realm", async () => {
    const kind = await runGuestCell(
      'const p = tools.get_profile({ id: "BGD101" }); return p.constructor.constructor("return typeof process")();',
    );
    expect(kind).toBe("undefined");
  });

  test("a value that cannot cross the boundary is rejected", async () => {
    await expect(runGuestCell("return Symbol('x')")).rejects.toThrow(
      /cannot cross the boundary/,
    );
  });
});
