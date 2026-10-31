import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  aggregatePositions,
  cacheFromSnapshot,
  fetchPolymarketSnapshot,
  fetchWalletPositions,
  parsePolymarketPosition,
  reconcileSnapshot,
  type PositionCache,
} from "../lib/polymarket_ingest.ts";

const ADDRESS = (suffix: string): string => `0x${"0".repeat(38)}${suffix}`;
const W1 = ADDRESS("01");
const W_PAGED = ADDRESS("02");
const W_RETRY = ADDRESS("03");
const W_SLOW = ADDRESS("04");
const W_BAD = ADDRESS("0a");

function position(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proxyWallet: W1,
    asset: "asset-1",
    conditionId: "0xcondition",
    size: 100,
    avgPrice: 0.5,
    initialValue: 50,
    currentValue: 60,
    cashPnl: 10,
    curPrice: 0.6,
    redeemable: false,
    title: "Will Team A win?",
    slug: "team-a",
    eventId: "1",
    outcome: "Yes",
    endDate: "2026-12-31",
    ...overrides,
  };
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let inFlight = 0;
let maxInFlight = 0;
const attempts = new Map<string, number>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const user = url.searchParams.get("user") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "500");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (user === W_SLOW) {
          await Bun.sleep(120);
        }
        if (user === W_RETRY) {
          const count = (attempts.get(user) ?? 0) + 1;
          attempts.set(user, count);
          if (count === 1) return new Response("rate limited", { status: 500 });
        }
        if (user === W_BAD) return Response.json({ error: "nope" });

        const rows =
          user === W_PAGED
            ? [
                position({ asset: "a1", title: "Paged one", currentValue: 10 }),
                position({ asset: "a2", title: "Paged two", currentValue: 20 }),
                position({ asset: "a3", title: "Paged three", currentValue: 30 }),
              ]
            : [position(), position({ asset: "asset-2", redeemable: true, title: "Redeemable", currentValue: 30 })];
        return Response.json(rows.slice(offset, offset + limit));
      } finally {
        inFlight -= 1;
      }
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/positions`;
});

afterAll(() => {
  server.stop(true);
});

describe("Polymarket positions ingestion", () => {
  test("parses rows and rejects unusable ones", () => {
    expect(parsePolymarketPosition(position())?.asset).toBe("asset-1");
    expect(parsePolymarketPosition({ ...position(), asset: "" })).toBeNull();
    expect(parsePolymarketPosition({ ...position(), title: "" })).toBeNull();
    expect(parsePolymarketPosition("not-an-object")).toBeNull();
  });

  test("aggregate excludes redeemable positions from open legs", () => {
    const openA = parsePolymarketPosition(position())!;
    const openB = parsePolymarketPosition(
      position({ asset: "b", initialValue: 2, currentValue: 1, cashPnl: -1, title: "Small" }),
    )!;
    const redeemed = parsePolymarketPosition(
      position({ asset: "c", redeemable: true, initialValue: 30, currentValue: 30, title: "Redeemed" }),
    )!;

    const aggregate = aggregatePositions([openA, openB, redeemed]);
    expect(aggregate.openPositionsCount).toBe(3);
    expect(aggregate.openLegsCount).toBe(2);
    expect(aggregate.openCostUsd).toBe(52);
    expect(aggregate.openValueUsd).toBe(61);
    expect(aggregate.openPnlUsd).toBe(9);
    expect(aggregate.summary).toContain("Will Team A win? (Yes) $60");
    expect(aggregate.summary).not.toContain("Redeemed");
  });

  test("fetches a wallet over HTTP", async () => {
    const result = await fetchWalletPositions(W1, { baseUrl, retryDelayMs: 0 });
    expect(result.status).toBe("ok");
    expect(result.error).toBeNull();
    expect(result.positions).toHaveLength(2);
    expect(result.aggregate?.openLegsCount).toBe(1);
  });

  test("follows pagination and reports truncation when maxPages is hit", async () => {
    const full = await fetchWalletPositions(W_PAGED, {
      baseUrl,
      pageSize: 2,
      maxPages: 2,
      retryDelayMs: 0,
    });
    expect(full.status).toBe("ok");
    expect(full.pages).toBe(2);
    expect(full.positions).toHaveLength(3);
    expect(full.truncated).toBe(false);

    const capped = await fetchWalletPositions(W_PAGED, {
      baseUrl,
      pageSize: 2,
      maxPages: 1,
      retryDelayMs: 0,
    });
    expect(capped.pages).toBe(1);
    expect(capped.positions).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  test("retries once on 5xx", async () => {
    const result = await fetchWalletPositions(W_RETRY, { baseUrl, retryDelayMs: 0 });
    expect(result.status).toBe("ok");
    expect(attempts.get(W_RETRY)).toBe(2);
    expect(result.positions.length).toBeGreaterThan(0);
  });

  test("classifies timeouts and non-array bodies as errors", async () => {
    const slow = await fetchWalletPositions(W_SLOW, { baseUrl, timeoutMs: 20, retryDelayMs: 0 });
    expect(slow.status).toBe("error");
    expect(slow.error).toBe("timeout");

    const bad = await fetchWalletPositions(W_BAD, { baseUrl, retryDelayMs: 0 });
    expect(bad.status).toBe("error");
    expect(bad.error).toContain("unexpected body");
  });

  test("bounds concurrency and preserves input order", async () => {
    const addresses = [W1, W_PAGED, W_RETRY, W_SLOW, W_BAD];
    const snapshot = await fetchPolymarketSnapshot(addresses, {
      baseUrl,
      concurrency: 2,
      timeoutMs: 200,
      retryDelayMs: 0,
    });
    expect(snapshot.requested).toBe(5);
    expect(snapshot.wallets.map((wallet) => wallet.address)).toEqual(addresses);
    // Handler-side accounting includes a response whose body is still streaming to the client,
    // so allow one transport overlap on top of the two-worker pool.
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(snapshot.ok).toBeGreaterThanOrEqual(3);
    expect(snapshot.failed).toBeGreaterThanOrEqual(1);
  });

  test("reconciles LIVE, STALE and FIXTURE", async () => {
    const ok = await fetchWalletPositions(W1, { baseUrl, retryDelayMs: 0 });
    const failed = await fetchWalletPositions(W_BAD, { baseUrl, retryDelayMs: 0 });
    const snapshot = {
      source: baseUrl,
      fetchedAtIso: "2026-10-31T18:00:00.000Z",
      durationMs: 10,
      requested: 3,
      ok: 1,
      failed: 1,
      truncatedWallets: [],
      wallets: [
        ok,
        failed,
        { ...failed, address: ADDRESS("0b") },
      ],
    };
    const cache: PositionCache = {
      schemaVersion: 1,
      wallets: {
        [W_BAD]: { aggregate: aggregatePositions([parsePolymarketPosition(position())!]), fetchedAtIso: "2026-10-31T17:00:00.000Z" },
      },
    };

    const states = reconcileSnapshot(snapshot, cache);
    expect(states.find((state) => state.address === W1)?.dataSource).toBe("LIVE");
    const stale = states.find((state) => state.address === W_BAD);
    expect(stale?.dataSource).toBe("STALE");
    expect(stale?.staleSinceIso).toBe("2026-10-31T17:00:00.000Z");
    expect(stale?.lastError).toContain("unexpected body");
    expect(states.find((state) => state.address === ADDRESS("0b"))?.dataSource).toBe("FIXTURE");

    const saved = cacheFromSnapshot(snapshot);
    expect(Object.keys(saved.wallets)).toEqual([W1]);
  });
});
