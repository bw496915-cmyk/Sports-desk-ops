import { describe, expect, test } from "bun:test";
import {
  checkSchema,
  findTemporal,
  hasKeyDeep,
  temporalType,
} from "../scripts/validate_dashboard_config.ts";
import {
  DASHBOARD_API,
  dashboardApiUrl,
} from "../packages/ui/src/config/dashboard.ts";

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

  test("rejects an api endpoint that is not a path", () => {
    const issues = checkSchema(
      {
        api: {
          tiers: "api/config/tiers",
          customers: "/x",
          wagers: "/y",
          dashboard: "/z",
        },
      },
      "d.toml",
    );
    expect(issues.some((issue) => issue.message.includes("api.tiers"))).toBe(
      true,
    );
  });

  test("accepts an empty or absolute-origin base", () => {
    const withBase = (base: string) =>
      checkSchema(
        {
          api: {
            base,
            tiers: "/a",
            customers: "/b",
            wagers: "/c",
            dashboard: "/d",
          },
        },
        "d.toml",
      );
    expect(withBase("")).toEqual([]);
    expect(withBase("http://127.0.0.1:4021")).toEqual([]);
  });

  test("rejects a base with a path or a non-URL", () => {
    const withBase = (base: string) => checkSchema({ api: { base } }, "d.toml");
    expect(withBase("/api").length).toBeGreaterThan(0);
    expect(
      withBase("http://x.test/api").some((i) => i.message.includes("origin")),
    ).toBe(true);
    expect(
      withBase("not a url").some((i) => i.message.includes("absolute URL")),
    ).toBe(true);
  });

  test("rejects a freshness budget beyond a day", () => {
    expect(
      checkSchema({ freshness: { stale_after_minutes: 1441 } }, "d.toml").some(
        (i) => i.message.includes("1440"),
      ),
    ).toBe(true);
  });

  test("rejects an api endpoint that is not a path", () => {
    const issues = checkSchema(
      {
        api: {
          tiers: "api/config/tiers",
          customers: "/x",
          wagers: "/y",
          dashboard: "/z",
        },
      },
      "d.toml",
    );
    expect(issues.some((issue) => issue.message.includes("api.tiers"))).toBe(
      true,
    );
  });

  test("rejects a non-positive freshness budget", () => {
    const issues = checkSchema(
      { freshness: { stale_after_minutes: 0 } },
      "d.toml",
    );
    expect(
      issues.some((issue) => issue.message.includes("stale_after_minutes")),
    ).toBe(true);
  });

  test("accepts the extended document shape", () => {
    expect(
      checkSchema(
        {
          api: {
            base: "",
            tiers: "/api/config/tiers",
            customers: "/api/customers",
            wagers: "/api/wagers",
            dashboard: "/api/dashboard",
          },
          freshness: { stale_after_minutes: 30 },
        },
        "d.toml",
      ),
    ).toEqual([]);
  });

  test("rejects a non-number threshold", () => {
    const issues = checkSchema(
      { thresholds: { sharp: "70", steam: 0.05 }, leagues: { names: ["NFL"] } },
      "d.toml",
    );
    expect(issues.some((issue) => issue.message.includes("sharp"))).toBe(true);
  });
});

describe("dashboardApiUrl", () => {
  test("returns the path unchanged when the base is empty", () => {
    expect(DASHBOARD_API.base).toBe("");
    expect(dashboardApiUrl("/api/wagers", "")).toBe("/api/wagers");
  });

  test("joins a loopback origin without doubling the path", () => {
    expect(dashboardApiUrl("/api/wagers", "http://127.0.0.1:4021")).toBe(
      "http://127.0.0.1:4021/api/wagers",
    );
    expect(dashboardApiUrl("/api/wagers", "http://127.0.0.1:4021/api")).toBe(
      "http://127.0.0.1:4021/api/wagers",
    );
  });

  test("a loopback ?apiBase wins over the committed base", () => {
    (globalThis as { location?: unknown }).location = {
      search: "?apiBase=http://127.0.0.1:9999",
    };
    try {
      expect(dashboardApiUrl("/api/wagers")).toBe(
        "http://127.0.0.1:9999/api/wagers",
      );
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });

  test("a non-loopback ?apiBase is ignored", () => {
    (globalThis as { location?: unknown }).location = {
      search: "?apiBase=http://evil.test",
    };
    try {
      expect(dashboardApiUrl("/api/wagers")).toBe("/api/wagers");
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });
});
