import { describe, expect, test } from "bun:test";
import {
  isRow,
  nullableStringColumn,
  numberColumn,
  parseRows,
  stringColumn,
} from "../lib/row_parse.ts";

describe("row parsing", () => {
  test("reads typed columns", () => {
    const row = { id: "a", n: 3, maybe: null };
    expect(stringColumn(row, "id")).toBe("a");
    expect(numberColumn(row, "n")).toBe(3);
    expect(nullableStringColumn(row, "maybe")).toBeNull();
  });

  test("refuses to invent a value for a missing column", () => {
    // String(undefined) would have produced "undefined"; this must throw instead.
    expect(() => stringColumn({}, "id")).toThrow('missing column "id"');
    expect(() => numberColumn({}, "n")).toThrow('missing column "n"');
  });

  test("rejects the wrong column type with the column name", () => {
    expect(() => stringColumn({ id: 7 }, "id")).toThrow(
      'column "id" is number, expected string',
    );
    expect(() => numberColumn({ n: "3" }, "n")).toThrow('column "n" is string');
    expect(() => numberColumn({ n: Number.NaN }, "n")).toThrow(
      "expected finite number",
    );
    expect(() => nullableStringColumn({ x: 1 }, "x")).toThrow(
      "expected string or null",
    );
  });

  test("parseRows names the failing row index", () => {
    expect(() =>
      parseRows([{ id: "a" }, { nope: true }], (row) =>
        stringColumn(row, "id"),
      ),
    ).toThrow('row 1: missing column "id"');
    expect(() => parseRows([null], () => "")).toThrow("row 0 is not an object");
  });

  test("isRow excludes arrays and null", () => {
    expect(isRow({})).toBe(true);
    expect(isRow([])).toBe(false);
    expect(isRow(null)).toBe(false);
    expect(isRow("x")).toBe(false);
  });
});
