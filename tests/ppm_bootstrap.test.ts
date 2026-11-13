/**
 * @file tests/ppm_bootstrap.test.ts
 * @description The price bootstrap, tested against a real crop: decimals, lines,
 * two-sided values, periods, and the events that legitimately have no prices.
 */
import { describe, expect, test } from "bun:test";
import { parsePpmBootstrap } from "../lib/ppm_bootstrap.ts";

const CROP = new URL("./fixtures/ppm/bootstrap.crop.json", import.meta.url);
const BOOTSTRAP = parsePpmBootstrap(await Bun.file(CROP).json());

const ONE_SIDED_CROP = new URL(
  "./fixtures/ppm/bootstrap.one-sided.crop.json",
  import.meta.url,
);
const ONE_SIDED = parsePpmBootstrap(await Bun.file(ONE_SIDED_CROP).json());

function event(eventId: string) {
  const found = BOOTSTRAP.events.find(
    (candidate) => candidate.eventId === eventId,
  );
  if (!found) throw new Error(`event ${eventId} missing from the bootstrap`);
  return found;
}

function oneSidedEvent(eventId: string) {
  const found = ONE_SIDED.events.find(
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

describe("one-sided quotes", () => {
  test("a placeholder second element is not a price", () => {
    const exact = oneSidedEvent("208809881").markets.find(
      (m) => m.marketId === 16,
    );
    expect(exact).toBeDefined();
    expect(exact!.points).toHaveLength(4);
    expect(exact!.points.map((p) => p.decimal)).toEqual([4, 5, 2.2, 4.5]);
    expect(exact!.points.every((p) => p.decimal > 1.01)).toBe(true);
  });

  test("a missing side of a line keeps the side that exists", () => {
    const total = oneSidedEvent("189007771").markets.find(
      (m) => m.marketId === 5,
    );
    expect(total).toBeDefined();
    expect(total!.points).toHaveLength(1);
    expect(total!.points[0]!.key).toBe("28.5");
    expect(total!.points[0]!.line).toBe(28.5);
    expect(total!.points[0]!.side).toBe(1);
    expect(total!.points[0]!.decimal).toBeCloseTo(15.88, 5);
  });

  test("a per-outcome key is not a line, even when it is numeric", () => {
    const exact = oneSidedEvent("208809881").markets.find(
      (m) => m.marketId === 16,
    );
    expect(exact!.points.map((p) => p.line)).toEqual([null, null, null, null]);
    expect(exact!.points.map((p) => p.side)).toEqual([null, null, null, null]);
  });

  test("moneyline selections stay lineless", () => {
    const moneyline = oneSidedEvent("208809881").markets.find(
      (m) => m.marketId === 3,
    );
    expect(moneyline!.points.map((p) => p.key)).toEqual(["1", "2"]);
    expect(moneyline!.points.every((p) => p.line === null)).toBe(true);
    expect(moneyline!.line).toBeNull();
  });

  test("set/period codes pass through instead of becoming 'full'", () => {
    const markets = oneSidedEvent("208841951").markets;
    expect(new Set(markets.map((m) => m.period))).toEqual(
      new Set(["full", "s1"]),
    );
    const set1 = markets.find((m) => m.period === "s1");
    expect(set1!.points.map((p) => p.decimal)).toEqual([2, 1.769231]);
  });
});
