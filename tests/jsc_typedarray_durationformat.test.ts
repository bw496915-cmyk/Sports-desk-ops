/**
 * @file tests/jsc_typedarray_durationformat.test.ts
 * @description Regression contracts for the JavaScriptCore fixes in Bun v1.4.2.
 *
 * They cover TypedArray construction from an array whose elements mutate during
 * ToNumber, `slice` into an overlapping species view, the DurationFormat
 * digital separator when minutes are hidden, and clearing a Proxy handler's
 * prototype after it has served a trap. The repository pin includes the fixes;
 * these tests keep a runtime downgrade or regression from silently undoing them.
 */

import { describe, expect, test } from "bun:test";

type NumericElement = number | { valueOf(): number };

/** The runtime deliberately gets objects here; the lib types see only numbers. */
function asNumericArray(values: NumericElement[]): number[] {
  return values as unknown as number[];
}

describe("TypedArray construction snapshots array elements", () => {
  test("a valueOf that overwrites a later element is not observed", () => {
    const values: NumericElement[] = [
      0,
      {
        valueOf() {
          values[2] = 42;
          return 100;
        },
      },
      2,
    ];

    const array = new Int32Array(asNumericArray(values));

    expect(array.length).toBe(3);
    expect([...array]).toEqual([0, 100, 2]);
  });

  test("a valueOf that shrinks the array preserves the original length and values", () => {
    const values: NumericElement[] = [
      0,
      {
        valueOf() {
          values.length = 0;
          return 100;
        },
      },
      2,
    ];

    const array = new Float64Array(asNumericArray(values));

    expect(array.length).toBe(3);
    expect([...array]).toEqual([0, 100, 2]);
  });

  test("a valueOf that grows the array does not extend the typed array", () => {
    const values: NumericElement[] = [
      0,
      {
        valueOf() {
          values.push(42);
          return 100;
        },
      },
      2,
    ];

    const array = new Int32Array(asNumericArray(values));

    expect(array.length).toBe(3);
    expect([...array]).toEqual([0, 100, 2]);
  });
});

describe("TypedArray.prototype.slice with an overlapping species view", () => {
  test("copies in spec order, not backwards", () => {
    const buffer = new ArrayBuffer(16);
    const source = new Int32Array(buffer, 0, 3);
    source.set([1, 2, 3]);

    // `slice` reads `constructor` to pick its species. Give the source a
    // species that writes into an overlapping view of the same buffer.
    Object.defineProperty(source, "constructor", {
      configurable: true,
      value: class extends Int32Array {
        constructor(length: number) {
          super(buffer, 4, length);
        }
      },
    });

    const result = source.slice();

    expect([...result]).toEqual([1, 1, 1]);
    expect([...new Int32Array(buffer)]).toEqual([1, 1, 1, 1]);
  });
});

interface DurationFormatLike {
  format(duration: Record<string, number>): string;
}

type DurationFormatConstructor = new (
  locale: string,
  options?: Record<string, string>,
) => DurationFormatLike;

const DurationFormat = (
  Intl as unknown as { DurationFormat?: DurationFormatConstructor }
).DurationFormat;

describe("Intl.DurationFormat digital separator", () => {
  test.skipIf(DurationFormat === undefined)(
    "omits the separator when auto-displayed minutes are hidden",
    () => {
      const format = new DurationFormat!("en-US", {
        style: "digital",
        hoursDisplay: "auto",
        minutesDisplay: "auto",
      });

      expect(format.format({ minutes: 0 })).toBe("00");
      expect(format.format({ hours: 1, minutes: 0, seconds: 5 })).toBe(
        "1:00:05",
      );
    },
  );
});

describe("Proxy handler prototype changes", () => {
  test("clearing a handler prototype after a trap does not crash", () => {
    for (let index = 0; index < 1_000; index += 1) {
      const handler = new (class {
        get(target: { x: number }, key: "x"): number {
          return target[key];
        }
      })();
      const proxy = new Proxy({ x: index }, handler);

      expect(proxy.x).toBe(index);
      Object.setPrototypeOf(handler, null);
      expect(proxy.x).toBe(index);
    }
  });
});
