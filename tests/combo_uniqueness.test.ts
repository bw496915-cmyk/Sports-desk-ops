import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildComboUniquenessReport } from "../lib/combo_uniqueness.ts";

const W1 = `0x${"1".repeat(40)}`;
const W2 = `0x${"2".repeat(40)}`;

const GAMES = [
  {
    id: "g1",
    slug: "cfb-g1",
    title: "Game One",
    volume24hr: 1000,
    markets: [
      { conditionId: "0x1", slug: "g1-ml", clobTokenIds: '["t1","t2"]', sportsMarketType: "moneyline" },
    ],
  },
  {
    id: "g2",
    slug: "cfb-g2",
    title: "Game Two",
    volume24hr: 500,
    markets: [
      { conditionId: "0x2", slug: "g2-ml", clobTokenIds: '["t3","t4"]', sportsMarketType: "moneyline" },
    ],
  },
];

function leg(conditionId: string, type = "moneyline", extra: Record<string, unknown> = {}) {
  return {
    leg_condition_id: conditionId,
    market: { condition_id: conditionId, sports_market_type: type, slug: `${conditionId}-slug` },
    ...extra,
  };
}

const COMBOS = [
  { id: "c1", legs: [leg("0x1")] },
  { id: "c2", legs: [leg("0x1"), leg("0x2")] },
  { id: "c3", legs: [leg("0x9")] },
  { id: "c4", legs: [leg("0x1", "player_props")] },
  { id: "c5", legs: [{ marketSlug: "g1-ml", market: { sports_market_type: "moneyline" } }] },
  { id: "c6", legs: [{ clobTokenId: "t3", market: { sports_market_type: "moneyline" } }] },
];

let server: ReturnType<typeof Bun.serve>;
let base = "";
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cfb-combo-cache-"));
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/events")) return Response.json(GAMES);
      if (url.pathname.endsWith("/v2/leaderboard")) {
        return Response.json({ data: [{ user_id: W1 }, { user_id: W2 }] });
      }
      if (url.pathname.endsWith("/v2/activity/combos")) {
        const user = url.searchParams.get("user");
        return Response.json({
          data: user === W1 ? COMBOS : [],
          pagination: { next_cursor: "" },
        });
      }
      if (url.pathname.endsWith("/v2/positions/combos")) {
        const user = url.searchParams.get("user");
        return Response.json({
          data: user === W1 ? [COMBOS[0]] : [],
          pagination: { next_cursor: "" },
        });
      }
      if (url.pathname.endsWith("/trades")) return Response.json([]);
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    gammaBase: base,
    dataBase: base,
    cacheDir: dir,
    cacheTtlHours: 24,
    leaderboardLimit: 10,
    ...overrides,
  };
}

describe("CFB combo uniqueness", () => {
  test("attributes by condition id, slug and token id; dedupes across endpoints", async () => {
    const report = await buildComboUniquenessReport(options());
    expect(report.walletsScanned).toBe(2);
    expect(report.comboRecords).toBe(6); // c1 appears in both endpoints
    expect(report.global.distinctCombos).toBe(5);
    expect(report.global.distinctWallets).toBe(1);

    const g1 = report.games.find((game) => game.gameSlug === "cfb-g1");
    const g2 = report.games.find((game) => game.gameSlug === "cfb-g2");
    expect(g1?.uniqueCombos).toBe(4); // c1, c2, c4, c5
    expect(g1?.fullyWithinGame).toBe(3); // c1, c4, c5
    expect(g2?.uniqueCombos).toBe(2); // c2, c6
    expect(g2?.fullyWithinGame).toBe(1); // c6
    expect(report.global.sumPerGameCombos).toBe(6);
  });

  test("strict mode keeps only single-game ML/spread/total combos", async () => {
    const report = await buildComboUniquenessReport(options({ strictFullGame: true }));
    expect(report.strictFullGame).toBe(true);
    expect(report.global.distinctCombos).toBe(3); // c1, c5, c6
    const g1 = report.games.find((game) => game.gameSlug === "cfb-g1");
    const g2 = report.games.find((game) => game.gameSlug === "cfb-g2");
    expect(g1?.uniqueCombos).toBe(2);
    expect(g2?.uniqueCombos).toBe(1);
  });

  test("cache honors TTL and fresh bypass", async () => {
    const first = await buildComboUniquenessReport(options({ fresh: true }));
    expect(first.cache.misses).toBe(2);
    expect(first.cache.hits).toBe(0);

    const second = await buildComboUniquenessReport(options());
    expect(second.cache.hits).toBe(2);
    expect(second.cache.misses).toBe(0);

    const expired = await buildComboUniquenessReport(options({ cacheTtlHours: 0 }));
    expect(expired.cache.misses).toBe(2);
    expect(expired.cache.hits).toBe(0);
  });
});
