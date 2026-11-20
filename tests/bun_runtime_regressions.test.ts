import { describe, expect, test } from "bun:test";

describe("Contract #39: Bun v1.4.2+ runtime regression invariants", () => {
  test("Response.prototype.json() surfaces SyntaxError details instead of generic failure", async () => {
    const response = new Response('{"ok": true, }', {
      headers: { "content-type": "application/json" },
    });
    let caught: unknown;
    try {
      await response.json();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SyntaxError);
    if (!(caught instanceof SyntaxError)) {
      throw new Error("Expected malformed JSON to reject with SyntaxError");
    }
    expect(caught.message).not.toBe("Failed to parse JSON");
    expect(caught.message.length).toBeGreaterThan(0);
  });

  test("Intl.PluralRules handles BigInt without TypeError", () => {
    const rules = new Intl.PluralRules("en");
    // The standard library declaration accepts number; exercise Bun's BigInt runtime extension.
    expect(Reflect.apply(rules.select, rules, [1n])).toBe("one");
    expect(Reflect.apply(rules.select, rules, [2n])).toBe("other");
  });
});
