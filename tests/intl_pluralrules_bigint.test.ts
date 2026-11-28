/**
 * @file tests/intl_pluralrules_bigint.test.ts
 * @description Pin JSC's BigInt support for `Intl.PluralRules.select`.
 *
 * The Bun v1.4.2 JavaScriptCore upgrade made BigInt operands work
 * (`select(1n)` was a TypeError before). The repository pin includes it;
 * this test keeps a later runtime change or a downgrade from silently
 * reintroducing the TypeError.
 */

import { describe, expect, test } from "bun:test";

/**
 * The runtime accepts BigInt, but the bundled TypeScript lib still declares
 * `select(n: number)`. View the method structurally at this boundary so the
 * test asserts the runtime contract, not the stale declaration.
 */
function select(rules: Intl.PluralRules, value: number | bigint): string {
  return (rules.select as (operand: number | bigint) => string)(value);
}

describe("Intl.PluralRules.select with BigInt", () => {
  test("cardinal rules accept BigInt operands", () => {
    const rules = new Intl.PluralRules("en");

    expect(select(rules, 1n)).toBe("one");
    expect(select(rules, 2n)).toBe("other");
    expect(select(rules, 11n)).toBe("other");
  });

  test("ordinal rules accept BigInt operands", () => {
    const rules = new Intl.PluralRules("en", { type: "ordinal" });

    expect(select(rules, 1n)).toBe("one");
    expect(select(rules, 2n)).toBe("two");
    expect(select(rules, 3n)).toBe("few");
  });

  test("BigInt and Number operands select the same category", () => {
    const rules = new Intl.PluralRules("en");

    for (const value of [0, 1, 2, 5, 11, 21]) {
      expect(select(rules, BigInt(value))).toBe(select(rules, value));
    }
  });
});
