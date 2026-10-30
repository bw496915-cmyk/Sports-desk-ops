import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildCatalogDiffReport } from "../fantasy402_sport_catalog_diff.ts";
import {
  configuredExpectedEmptySubSportNameCount,
  computeCatalogProvenance,
  liveSportSurfaceChanged,
  loadFantasy402SportCatalogFromFile,
  makeDeskLinkId,
  PINNED_EXPECTED_EMPTY_SUBSPORT_PATHS,
  periodTemplateKey,
  parseFantasy402SportCatalog,
  validateFantasy402SportCatalog,
} from "../fantasy402_sport_catalog.ts";

const FIXTURE = join(
  import.meta.dir,
  "fixtures/fantasy402-sport-catalog-2026-10-21.json",
);

describe("fantasy402_sport_catalog", () => {
  test("expected empty count is derived from config arrays + tree (not literal 6)", async () => {
    const catalog = await loadFantasy402SportCatalogFromFile(FIXTURE);
    const { metrics } = computeCatalogProvenance(catalog);
    const configured = configuredExpectedEmptySubSportNameCount(
      catalog.expectedEmptySubSportPaths,
    );

    expect(configured).toBe(6);
    expect(metrics.emptyNames.configuredExpectedEmptySubSportNameCount).toBe(6);
    expect(metrics.emptyNames.expectedEmptySubSportNameCount).toBe(configured);
    expect(metrics.emptyNames.unexpectedEmptySubSportNameCount).toBe(0);

    // Stable bucket: exact path set (terminal taxonomy nodes — rarely churn).
    expect(catalog.expectedEmptySubSportPaths.stable.sort()).toEqual(
      [...PINNED_EXPECTED_EMPTY_SUBSPORT_PATHS.stable].sort(),
    );
    // Volatile bucket: count-only in unit test; path renames/adds gated by catalog diff exit 4.
    // "volatile" labels LIVE surface churn risk, not permission to drift without diff review.
    expect(catalog.expectedEmptySubSportPaths.volatile.length).toBe(
      PINNED_EXPECTED_EMPTY_SUBSPORT_PATHS.volatile.length,
    );

    expect(validateFantasy402SportCatalog(catalog).ok).toBe(true);
  });

  test("config/path drift fails validate when arrays disagree with tree", async () => {
    const catalog = await loadFantasy402SportCatalogFromFile(FIXTURE);
    catalog.expectedEmptySubSportPaths.stable.push("Fake/NotInTree");
    const result = validateFantasy402SportCatalog(catalog);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((i) => i.kind === "expected_empty_count_drift"),
    ).toBe(true);
  });

  test("periodsCapturedAt-only change does not trigger LIVE migration warning", async () => {
    const catalog = await loadFantasy402SportCatalogFromFile(FIXTURE);
    const probe = structuredClone(catalog);
    probe.periodsCapturedAt = "2026-11-01T00:00:00.000Z";
    expect(liveSportSurfaceChanged(catalog, probe)).toBe(false);
    const report = buildCatalogDiffReport(catalog, probe);
    expect(report.rows.some((r) => r.category === "Migration risks")).toBe(
      false,
    );
  });

  test("LIVE subSport rename triggers migration warning row", async () => {
    const catalog = await loadFantasy402SportCatalogFromFile(FIXTURE);
    const probe = structuredClone(catalog);
    probe.sports
      .find((s) => s.sport === "LIVE")!
      .subSports.find((s) => s.code === "MMA Live")!.name = "MMA Live Betting";
    expect(liveSportSurfaceChanged(catalog, probe)).toBe(true);
    const report = buildCatalogDiffReport(catalog, probe);
    expect(
      report.rows.find((r) => r.category === "Migration risks")?.detail,
    ).toContain("LIVE");
  });

  test("filling a structural empty is exit 4 (not a cleanup win)", async () => {
    const catalog = await loadFantasy402SportCatalogFromFile(FIXTURE);
    const probe = structuredClone(catalog);
    probe.sports
      .find((s) => s.sport === "Horse Racing")!
      .subSports.find((s) => s.code === "Arena")!.name = "Arena Racing";

    const report = buildCatalogDiffReport(catalog, probe);
    expect(report.exitCode).toBe(4);
    expect(validateFantasy402SportCatalog(probe).ok).toBe(false);
  });

  test("makeDeskLinkId uses registry and throws on unlisted sport", async () => {
    const catalog = await loadFantasy402SportCatalogFromFile(FIXTURE);
    const deskLinkId = makeDeskLinkId(catalog.collisions);
    expect(deskLinkId("Football", "Arena")).toBe("Football|Arena");
    expect(() => deskLinkId("Tennis", "Arena")).toThrow(/not sport/);
  });

  test("parse rejects valid_from alias", () => {
    expect(() =>
      parseFantasy402SportCatalog({
        provider: "fantasy402",
        valid_from: "2026-01-01T00:00:00.000Z",
        sports: [],
      }),
    ).toThrow(/valid_from is not accepted/);
  });

  test("period templates cluster by sport shape", async () => {
    const catalog = await loadFantasy402SportCatalogFromFile(FIXTURE);
    const { metrics } = computeCatalogProvenance(catalog);
    expect(new Set(Object.values(metrics.periodTemplateBySport)).size).toBe(5);
    const basketball = catalog.sports.find((s) => s.sport === "Basketball");
    expect(periodTemplateKey(basketball!.periods)).toContain("1st Quarter");
  });
});
