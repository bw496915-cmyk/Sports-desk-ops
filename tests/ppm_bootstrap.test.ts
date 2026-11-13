/**
 * @file tests/ppm_bootstrap.test.ts
 * @description The price bootstrap, tested against a real crop: decimals, lines,
 * two-sided values, periods, and the events that legitimately have no prices.
 */
import { describe, expect, test } from "bun:test";
import { parsePpmBootstrap } from "../lib/ppm_bootstrap.ts";

const CROP = new URL("./fixtures/ppm/bootstrap.crop.json", import.meta.url);
const BOOTSTRAP = parsePpmBootstrap(await Bun.file(CROP).json());

function event(eventId: string) {
  const found = BOOTSTRAP.events.find(
    (candidate) => candidate.eventId === eventId,
  );
  if (!found) throw new Error(`event ${eventId} missing from the bootstrap`);
  return found;
}

describe("parsePpmBootstrap", () => {
  test("reports counts over the real crop", () => {
    expect(BOOTSTRAP.events.length).toBeGreaterThan(0);
    expect(BOOTSTRAP.counts.markets).toBeGreaterThan(0);
    expect(BOOTSTRAP.counts.pricePoints).toBeGreaterThanOrEqual(
      BOOTSTRAP.counts.markets,
    );
    expect(BOOTSTRAP.updatedAtMs).toBeGreaterThan(1_700_000_000_000);
  });

  test("moneyline prices are decimal per selection", () => {
    const moneyline = event("51603109").markets.find((m) => m.marketId === 3);
    expect(moneyline).toBeDefined();
    expect(moneyline!.period).toBe("full");
    const byKey = new Map(moneyline!.points.map((p) => [p.key, p.decimal]));
    expect(byKey.get("1")).toBeCloseTo(1.526316, 5);
    expect(byKey.get("2")).toBeCloseTo(2.5, 5);
    expect(moneyline!.points.every((p) => p.side === null)).toBe(true);
  });

  test("a total is two-sided on its line key", () => {
    const total = event("51603109").markets.find((m) => m.marketId === 5);
    expect(total).toBeDefined();
    expect(total!.line).toBe(48.5);
    expect(total!.points).toHaveLength(2);
    expect(total!.points.map((p) => p.side).sort()).toEqual([0, 1]);
    expect(total!.points[0]!.key).toBe("48.5");
    expect(total!.points[0]!.line).toBe(48.5);
    for (const point of total!.points)
      expect(point.decimal).toBeCloseTo(1.909091, 5);
  });

  test("a spread keeps the signed line as its key", () => {
    const spread = event("51603109").markets.find((m) => m.marketId === 6);
    expect(spread!.points[0]!.key).toBe("-3.5");
    expect(spread!.points[0]!.line).toBe(-3.5);
  });

  test("periods are separated", () => {
    const periods = new Set(event("51787613").markets.map((m) => m.period));
    expect(periods.has("full")).toBe(true);
    expect(periods.has("h1") || periods.has("h2")).toBe(true);
  });

  test("an event with no open market keeps its empty entry", () => {
    const empty = event("51808859");
    expect(empty.markets).toEqual([]);
  });

  test("refuses a payload that is not the bootstrap shape", () => {
    expect(() => parsePpmBootstrap(null)).toThrow();
    expect(() => parsePpmBootstrap([])).toThrow();
    expect(() => parsePpmBootstrap([{ c: null }])).toThrow();
  });
});
