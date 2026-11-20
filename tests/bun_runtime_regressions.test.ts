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

// JavaScriptCore changes shipped by Bun:
// https://github.com/oven-sh/bun/commit/d296efbb4e5bfcd45cd0e93da312c793a1f5b701
test("TypedArray constructor preserves iterable values when conversion shrinks the source", () => {
  const source: (number | { valueOf(): number })[] = [
    {
      valueOf() {
        source.length = 0;
        return 1;
      },
    },
    2,
  ];
  expect([...Reflect.construct(Int32Array, [source])]).toEqual([1, 2]);
  expect(source).toHaveLength(0);
});

// https://github.com/oven-sh/bun/commit/5fb9ecbf844650e55b7453162956a17db4b653e6
for (const bodyType of ["Response", "Blob"] as const) {
  test(`${bodyType}.json preserves the JSON.parse diagnostic`, async () => {
    const invalid = '{"ok": true, }';
    let diagnostic = "";
    try {
      JSON.parse(invalid);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      diagnostic = error.message;
    }
    expect(diagnostic.length).toBeGreaterThan(0);
    const body =
      bodyType === "Response" ? new Response(invalid) : new Blob([invalid]);
    try {
      await body.json();
      throw new Error("Invalid JSON unexpectedly parsed");
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError);
      if (!(error instanceof SyntaxError)) throw error;
      expect(error.message).toBe(diagnostic);
    }
  });
}
