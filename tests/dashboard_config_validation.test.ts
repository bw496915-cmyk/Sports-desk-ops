import { describe, expect, test } from "bun:test";
import {
  checkSchema,
  findTemporal,
  hasKeyDeep,
  temporalType,
} from "../scripts/validate_dashboard_config.ts";

describe("temporalType", () => {
  test("recognises a TOML datetime parsed to Temporal.Instant", () => {
    const parsed = Bun.TOML.parse("d = 2026-11-13T00:00:00Z") as { d: unknown };
    expect(temporalType(parsed.d)).toBe("Instant");
  });

  test("recognises a date-only value as Temporal.PlainDate", () => {
    const parsed = Bun.TOML.parse("d = 2026-11-13") as { d: unknown };
    expect(temporalType(parsed.d)).toBe("PlainDate");
  });

  test("returns null for strings, numbers and null", () => {
    expect(temporalType("2026-11-13T00:00:00Z")).toBeNull();
    expect(temporalType(0)).toBeNull();
    expect(temporalType(null)).toBeNull();
  });
});

describe("findTemporal", () => {
  test("locates a nested Temporal value by path", () => {
    const parsed = Bun.TOML.parse(
      "[meta]\ngenerated_at = 2026-11-13",
    ) as Record<string, unknown>;
    const found = findTemporal(parsed);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("$.meta.generated_at");
    expect(found[0]).toContain("PlainDate");
  });

  test("returns no paths for an all-quoted config", () => {
    expect(
      findTemporal({ meta: { generated_at: "2026-11-13T00:00:00Z" } }),
    ).toEqual([]);
  });

  test("walks arrays", () => {
    const parsed = Bun.TOML.parse("dates = [2026-01-01, 2026-02-01]") as Record<
      string,
      unknown
    >;
    expect(findTemporal(parsed).length).toBe(2);
  });
});

describe("hasKeyDeep", () => {
  test("finds a key at any depth", () => {
    expect(hasKeyDeep({ a: [{ b: 1 }] }, "b")).toBe(true);
    expect(hasKeyDeep({ a: [{ b: 1 }] }, "c")).toBe(false);
  });
});

describe("checkSchema", () => {
  test("accepts a config with thresholds and leagues", () => {
    expect(
      checkSchema(
        { thresholds: { sharp: 70, steam: 0.05 }, leagues: { names: ["NFL"] } },
        "d.toml",
      ),
    ).toEqual([]);
  });

  test("does not require sections by itself", () => {
    // Presence is enforced by the bundle probe (REQUIRED_PROBE) and the sentinel check;
    // checkSchema only validates the shape of sections that are present.
    expect(checkSchema({}, "d.toml")).toEqual([]);
  });

  test("rejects a thresholds section that is not a table", () => {
    const issues = checkSchema({ thresholds: 70 }, "d.toml");
    expect(issues.some((issue) => issue.message.includes("thresholds"))).toBe(
      true,
    );
  });

  test("rejects a non-number threshold", () => {
    const issues = checkSchema(
      { thresholds: { sharp: "70", steam: 0.05 }, leagues: { names: ["NFL"] } },
      "d.toml",
    );
    expect(issues.some((issue) => issue.message.includes("sharp"))).toBe(true);
  });
});
