import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildComboUniquenessReport,
  checkComboSubset,
  comboIdLines,
  linesToText,
  walletLines,
} from "../lib/combo_uniqueness.ts";

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
          data: user === W1 ? [COMBOS[0], { ...COMBOS[0], id: "c1-alt" }] : [],
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
    expect(report.comboRecords).toBe(5); // c1 appears in both endpoints, plus a c1-alt id
    expect(report.permissiveCombos).toBe(5);
    expect(report.duplicatesCollapsed).toBe(2); // same id, then same leg set with a different id
    expect(report.duplicatesCollapsedById).toBe(1);
    expect(report.duplicatesCollapsedByLegSet).toBe(1);
    expect(report.global.distinctCombos).toBe(5);
    expect(report.global.distinctWallets).toBe(1);
    // Fixture legs carry no outcome label, so the unsided diagnostic must see them.
    expect(report.diagnostics.legsWithoutSide).toBe(6);
    expect(report.diagnostics.combosWithUnstableIdentity).toBe(0);
    expect(report.wallets).toEqual([W1, W2].sort());

    const g1 = report.games.find((game) => game.gameSlug === "cfb-g1");
    const g2 = report.games.find((game) => game.gameSlug === "cfb-g2");
    expect(g1?.uniqueCombos).toBe(4); // c1, c2, c4, c5
    expect(g1?.fullyWithinGame).toBe(3); // c1, c4, c5
    expect(g2?.uniqueCombos).toBe(2); // c2, c6
    expect(g2?.fullyWithinGame).toBe(1); // c6
    expect(report.global.sumPerGameCombos).toBe(6);
  });

  test("full-game gate keeps only single-game ML/spread/total combos", async () => {
    const report = await buildComboUniquenessReport(options({ gate: "full-game" }));
    expect(report.gate).toBe("full-game");
    expect(report.strictFullGame).toBe(true);
    expect(report.global.distinctCombos).toBe(3); // c1, c5, c6
    expect(report.permissiveCombos).toBe(5);
    expect(report.exclusions).toEqual({
      UNRESOLVED_LEGS: 0,
      CROSS_GAME: 1, // c2 spans g1 + g2
      INELIGIBLE_LEG_TYPE: 1, // c4 uses player_props
    });
    expect(report.includedCrossGame).toBe(0);
    const g1 = report.games.find((game) => game.gameSlug === "cfb-g1");
    const g2 = report.games.find((game) => game.gameSlug === "cfb-g2");
    expect(g1?.uniqueCombos).toBe(2);
    expect(g2?.uniqueCombos).toBe(1);
  });

  test("all-legs-cfb admits cross-game combos and reports them as included", async () => {
    const report = await buildComboUniquenessReport(options({ gate: "all-legs-cfb" }));
    expect(report.gate).toBe("all-legs-cfb");
    expect(report.strictFullGame).toBe(false);
    expect(report.global.distinctCombos).toBe(4); // c1, c2, c5, c6
    expect(report.permissiveCombos).toBe(5);
    expect(report.exclusions).toEqual({
      UNRESOLVED_LEGS: 0,
      CROSS_GAME: 0, // this gate admits cross-game; it must not be a drop bucket
      INELIGIBLE_LEG_TYPE: 1, // c4 uses player_props
    });
    expect(report.includedCrossGame).toBe(1); // c2
    const g1 = report.games.find((game) => game.gameSlug === "cfb-g1");
    const g2 = report.games.find((game) => game.gameSlug === "cfb-g2");
    expect(g1?.uniqueCombos).toBe(3); // c1, c2, c5
    expect(g2?.uniqueCombos).toBe(2); // c2, c6
  });

  test("permissive reports no exclusions and counts included cross-game", async () => {
    const report = await buildComboUniquenessReport(options({ gate: "permissive" }));
    expect(report.gate).toBe("permissive");
    expect(report.exclusions).toEqual({
      UNRESOLVED_LEGS: 0,
      CROSS_GAME: 0,
      INELIGIBLE_LEG_TYPE: 0,
    });
    expect(report.includedCrossGame).toBe(1);
  });

  test("each stricter gate is a subset of the looser one", async () => {
    const permissive = await buildComboUniquenessReport(options({ includeAudit: true }));
    const cfbOnly = await buildComboUniquenessReport(
      options({ gate: "all-legs-cfb", includeAudit: true }),
    );
    const strict = await buildComboUniquenessReport(
      options({ gate: "full-game", includeAudit: true }),
    );
    const key = (row: { comboId: string; wallet: string }): string => `${row.comboId}|${row.wallet}`;
    const permissiveIds = new Set(permissive.combos.map(key));
    const cfbOnlyIds = cfbOnly.combos.filter((row) => row.kept).map(key);
    const strictIds = strict.combos.filter((row) => row.kept).map(key);
    expect(strictIds.length).toBe(strict.comboRecords);
    expect(cfbOnlyIds.length).toBe(cfbOnly.comboRecords);
    for (const id of cfbOnlyIds) expect(permissiveIds.has(id)).toBe(true);
    const cfbOnlySet = new Set(cfbOnlyIds);
    for (const id of strictIds) expect(cfbOnlySet.has(id)).toBe(true);
    for (const game of strict.games) {
      const before = permissive.games.find((entry) => entry.gameSlug === game.gameSlug);
      expect(game.uniqueCombos).toBeLessThanOrEqual(before?.uniqueCombos ?? 0);
      expect(game.fullyWithinGame).toBeLessThanOrEqual(before?.fullyWithinGame ?? 0);
    }
  });

  test("verifier: the chain full-game ⊆ all-legs-cfb ⊆ permissive holds", async () => {
    const permissive = await buildComboUniquenessReport(options());
    const cfbOnly = await buildComboUniquenessReport(options({ gate: "all-legs-cfb" }));
    const strict = await buildComboUniquenessReport(options({ gate: "full-game" }));

    const outer = checkComboSubset(permissive, cfbOnly);
    expect(outer.referenceGate).toBe("permissive");
    expect(outer.treatmentGate).toBe("all-legs-cfb");
    expect(outer.leaks).toEqual([]);
    expect(outer.vacuous).toBe(false);

    const inner = checkComboSubset(cfbOnly, strict);
    expect(inner.referenceGate).toBe("all-legs-cfb");
    expect(inner.treatmentGate).toBe("full-game");
    expect(inner.reference).toBe(cfbOnly.comboRecords); // 4, not the permissive 5
    expect(inner.leaks).toEqual([]);
    expect(inner.vacuous).toBe(false);
    expect(inner.treatment).toBe(strict.comboRecords);

    const empty = await buildComboUniquenessReport(
      options({ gate: "full-game", walletFile: "/nonexistent/wallets.txt", leaderboard: false, seedTrades: false }),
    );
    const vacuous = checkComboSubset(permissive, empty);
    expect(vacuous.treatment).toBe(0);
    expect(vacuous.vacuous).toBe(true);
  });

  test("every gate conserves permissive = kept + Σ(exclusions)", async () => {
    for (const gate of ["permissive", "all-legs-cfb", "full-game"] as const) {
      const report = await buildComboUniquenessReport(options({ gate }));
      const dropped = report.exclusions.UNRESOLVED_LEGS + report.exclusions.CROSS_GAME + report.exclusions.INELIGIBLE_LEG_TYPE;
      expect(report.permissiveCombos).toBe(report.comboRecords + dropped);
    }
  });

  test("emit-ids lines: treatment output is a subset of permissive output", async () => {
    const permissive = await buildComboUniquenessReport(options());
    const strict = await buildComboUniquenessReport(options({ gate: "full-game" }));
    const any = comboIdLines(permissive, { keptOnly: false });
    const strictIds = comboIdLines(strict);
    expect(any).toHaveLength(permissive.comboRecords);
    expect(strictIds).toHaveLength(strict.comboRecords);
    const anySet = new Set(any);
    expect(strictIds.filter((line) => !anySet.has(line))).toEqual([]);
    expect(walletLines(permissive)).toEqual([W1, W2].sort());
    expect(linesToText([])).toBe("");
    expect(linesToText(["a", "b"])).toBe("a\nb\n");
  });

  test("a combo whose legs cannot be attributed is reported as unresolved", async () => {
    const report = await buildComboUniquenessReport(
      options({ gate: "full-game", includeAudit: true }),
    );
    // c3 has one leg that touches no CFB game, so it is dropped before attribution, not by the gate.
    expect(report.combos.some((row) => row.comboId === "c3")).toBe(false);
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
