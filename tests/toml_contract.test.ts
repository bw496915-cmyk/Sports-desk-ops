import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The `Bun.TOML` behaviours the config adapters depend on.
 *
 * Reference: https://bun.com/reference/bun/TOML (fetched 2026-11-14, measured on
 * Bun 1.4.4). Every case below is a trap a refactor can fall into: passing a
 * `Bun.file()` Blob to `parse`, accepting an out-of-range integer, or writing a
 * config that `stringify` cannot round-trip.
 */

const SLAB = resolve(process.cwd(), "config/slab.toml");

describe("Bun.TOML contract", () => {
  test("a file-backed Blob throws: loaders must pass text, not Bun.file()", async () => {
    expect(() => Bun.TOML.parse(Bun.file(SLAB))).toThrow(/File blob/);

    const text = await Bun.file(SLAB).text();
    expect(() => Bun.TOML.parse(text)).not.toThrow();
    // A Blob holding bytes is fine; only a file-backed Blob is refused.
    expect(() => Bun.TOML.parse(new Blob([text]))).not.toThrow();
  });

  test("integers outside the safe range throw at parse", () => {
    // 2^53 and INT64_MAX cannot be represented losslessly as JS numbers; the
    // parse fails instead of rounding, which is why slab sentinels stay within
    // ±(2^53 - 1) and BigInt64 sentinels live as strings outside TOML.
    expect(() => Bun.TOML.parse("x = 9007199254740992")).toThrow(/losslessly/);
    expect(() => Bun.TOML.parse("x = 9223372036854775807")).toThrow(
      /losslessly/,
    );
    expect(Bun.TOML.parse("x = 9007199254740991")).toEqual({
      x: 9007199254740991,
    });
  });

  test("an unquoted date parses to Temporal, which the config validators reject", () => {
    const parsed = Bun.TOML.parse("d = 2026-11-14") as { d: unknown };
    expect(Object.prototype.toString.call(parsed.d)).toBe(
      "[object Temporal.PlainDate]",
    );
    // Quoting it keeps a string; this is the date contract every validator asserts.
    expect(Bun.TOML.parse('d = "2026-11-14"')).toEqual({ d: "2026-11-14" });
  });

  test("stringify matches the reference example and round-trips the slab config", () => {
    expect(Bun.TOML.stringify({ name: "app", server: { port: 8080 } })).toBe(
      'name = "app"\n\n[server]\nport = 8080\n',
    );

    const once = Bun.TOML.parse(readFileSync(SLAB, "utf8"));
    const twice = Bun.TOML.parse(Bun.TOML.stringify(once));
    expect(twice).toEqual(once);
  });

  test("Temporal is defined by default and compares by value", () => {
    // Bun >= 1.4.0: `Temporal` and `Date.prototype.toTemporalInstant` exist, and
    // deepEqual/toEqual compare Temporal objects by value rather than by class.
    expect(typeof Temporal).toBe("object");
    expect(typeof Temporal.PlainDate).toBe("function");
    expect(typeof Date.prototype.toTemporalInstant).toBe("function");

    expect(
      Bun.deepEquals(
        Temporal.PlainDate.from("2020-01-01"),
        Temporal.PlainDate.from("1999-12-31"),
      ),
    ).toBe(false);
    expect(
      Bun.deepEquals(
        Temporal.PlainDate.from("2020-01-01"),
        Temporal.PlainDate.from("2020-01-01"),
      ),
    ).toBe(true);
    // toEqual follows the same value semantics; before 1.4.0 any two instances
    // of one class compared equal, which would have hidden this difference.
    expect(Temporal.PlainDate.from("2020-01-01")).not.toEqual(
      Temporal.PlainDate.from("1999-12-31"),
    );

    // The dates a TOML document yields are distinguishable the same way.
    const first = Bun.TOML.parse("d = 2020-01-01") as { d: unknown };
    const second = Bun.TOML.parse("d = 1999-12-31") as { d: unknown };
    expect(Bun.deepEquals(first.d, second.d)).toBe(false);
    expect(first.d).not.toEqual(second.d);
  });

  test("BUN_JSC_useTemporal=0 removes the global", () => {
    const run = Bun.spawnSync(["bun", "-e", "console.log(typeof Temporal)"], {
      env: { ...process.env, BUN_JSC_useTemporal: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe("undefined");
  });

  test("stringify refuses values TOML cannot represent", () => {
    expect(() => Bun.TOML.stringify({ x: null })).toThrow(
      /cannot represent null/,
    );
    expect(() => Bun.TOML.stringify({ x: 1n })).toThrow(/BigInt/);
    // Function properties are skipped; a table with nothing left serializes empty.
    expect(Bun.TOML.stringify({ noop: () => {} })).toBe("");
  });
});
