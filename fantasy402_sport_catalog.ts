/**
 * Fantasy402 desk navigation catalog: subSport lanes + per-sport period menus.
 * Reference metadata only — not ingestion-audit.jsonl.
 */

import { sha256HexOfBytes } from "./sportsdesk_ingestion_feed_provenance.ts";

export type Fantasy402SubSport = {
  code: string;
  name: string;
};

export type Fantasy402Period = {
  name: string;
  number: number;
};

export type Fantasy402SportEntry = {
  sport: string;
  subSports: Fantasy402SubSport[];
  periods: Fantasy402Period[];
};

export type Fantasy402CollisionEntry = {
  code: string;
  sports: string[];
};

export type ExpectedEmptySubSportPaths = {
  stable: string[];
  volatile: string[];
};

export type CatalogMigrationRisk = {
  kind: string;
  code?: string;
  affects?: string[];
  note: string;
};

export type Fantasy402SportCatalog = {
  provider: string;
  capturedAt: string;
  sportCount: number;
  subSportCount: number;
  sports: Fantasy402SportEntry[];
  /** SSOT for scoped ingestion link_id keys (must match observed cross-sport codes). */
  collisions: Fantasy402CollisionEntry[];
  /** Domain-correct structural empties (sport/code paths), not quality defects. */
  expectedEmptySubSportPaths: ExpectedEmptySubSportPaths;
  migrationRisks?: CatalogMigrationRisk[];
  periodsCapturedAt?: string;
  sportPeriodCount?: number;
};

/** SSOT for fixture tests — stable vs volatile LIVE surface. */
export const PINNED_EXPECTED_EMPTY_SUBSPORT_PATHS: ExpectedEmptySubSportPaths =
  {
    stable: [
      "Football/Coll Ext",
      "Hockey/NCAA Extra",
      "Horse Racing/Arena",
      "Soccer/France Ligue",
    ],
    volatile: ["LIVE/MMA Live", "LIVE/WNCAA Live"],
  };

export type CatalogValidationIssue =
  | {
      kind: "count_mismatch";
      field: "sportCount" | "subSportCount" | "sportPeriodCount";
      declared: number;
      computed: number;
    }
  | {
      kind: "duplicate_code_in_sport";
      sport: string;
      code: string;
    }
  | {
      kind: "period_number_mismatch";
      sport: string;
      expectedNumbers: number[];
      actualNumbers: number[];
    }
  | { kind: "missing_game_period"; sport: string }
  | {
      kind: "structural_empty_subsport";
      path: string;
    }
  | {
      kind: "unexpected_empty_subsport";
      path: string;
    }
  | {
      kind: "expected_empty_path_filled";
      path: string;
      name: string;
    }
  | {
      kind: "missing_expected_empty_path";
      path: string;
    }
  | { kind: "missing_expected_empty_paths_config" }
  | {
      kind: "expected_empty_count_drift";
      configured: number;
      observedInTree: number;
    }
  | {
      kind: "inverted_timestamp";
      capturedAt: string;
      periodsCapturedAt: string;
    }
  | {
      kind: "collision_registry_mismatch";
      code: string;
      observedSports: string[];
      declaredSports: string[];
    }
  | { kind: "missing_collision_registry" };

export type CatalogValidationResult = {
  ok: boolean;
  issues: CatalogValidationIssue[];
  computed: {
    sportCount: number;
    subSportCount: number;
    sportPeriodCount: number;
  };
};

export type CatalogDigestSet = {
  subSportTreeSha256Hex: string;
  periodMenusSha256Hex: string;
  /** Declared registry in fixture (domain SSOT). */
  collisionRegistrySha256Hex: string;
  /** Cross-sport codes observed in the sport tree (diff / exit 3). */
  observedCollisionSetSha256Hex: string;
};

export type EmptySubSportNameAnalysis = {
  /** Empty rows in tree whose path is listed in expectedEmptySubSportPaths. */
  expectedEmptySubSportNameCount: number;
  unexpectedEmptySubSportNameCount: number;
  /** stable.length + volatile.length from fixture config. */
  configuredExpectedEmptySubSportNameCount: number;
  expectedEmptyPaths: string[];
  unexpectedEmptyPaths: string[];
  /** Expected structural empty now has a display name — link_id regression risk. */
  expectedPathsFilled: { path: string; name: string }[];
  missingExpectedEmptyPaths: string[];
};

export type CatalogMetrics = {
  emptyNames: EmptySubSportNameAnalysis;
  expectedEmptyPathsSha256Hex: string;
  computedCounts: {
    sportCount: number;
    subSportCount: number;
    sportPeriodCount: number;
  };
  periodTemplateBySport: Record<string, string>;
};

export type CatalogProvenance = {
  digests: CatalogDigestSet;
  metrics: CatalogMetrics;
};

/** Flat provenance view (digests + metrics). Prefer {@link CatalogProvenance}. */
export type CatalogProvenanceDigests = CatalogDigestSet &
  CatalogMetrics & {
    /** Alias of collisionRegistrySha256Hex */
    collisionSetSha256Hex: string;
    /** @deprecated use emptyNames.expected + unexpected */
    emptySubSportNameCount: number;
  };

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  });
}

function sha256HexOfStableJson(value: unknown): string {
  const bytes = new TextEncoder().encode(stableStringify(value));
  return sha256HexOfBytes(bytes);
}

export function canonicalSubSportTree(
  sports: Fantasy402SportEntry[],
): { sport: string; subSports: Fantasy402SubSport[] }[] {
  return sports
    .map((s) => ({
      sport: s.sport,
      subSports: [...s.subSports]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map(({ code, name }) => ({ code, name })),
    }))
    .sort((a, b) => a.sport.localeCompare(b.sport));
}

export function canonicalPeriodMenus(
  sports: Fantasy402SportEntry[],
): { sport: string; periods: Fantasy402Period[] }[] {
  return sports
    .map((s) => ({
      sport: s.sport,
      periods: [...s.periods].sort((a, b) => a.number - b.number),
    }))
    .sort((a, b) => a.sport.localeCompare(b.sport));
}

export function periodTemplateKey(periods: Fantasy402Period[]): string {
  return [...periods]
    .sort((a, b) => a.number - b.number)
    .map((p) => `${p.number}:${p.name}`)
    .join("|");
}

export type DeskLinkIdFn = (sport: string, code: string) => string;

/** Close over fixture collision registry at load — callers cannot omit it. */
export function makeDeskLinkId(
  collisions: Fantasy402CollisionEntry[],
): DeskLinkIdFn {
  const byCode = new Map(
    collisions.map((c) => [c.code, new Set(c.sports)] as const),
  );
  return (sport: string, code: string): string => {
    const sports = byCode.get(code);
    if (!sports) return code;
    if (!sports.has(sport)) {
      throw new Error(
        `collision registry lists "${code}" but not sport "${sport}" — refresh proposedCollisions or fix registry`,
      );
    }
    return `${sport}|${code}`;
  };
}

export function observedCollisionSetSha256Hex(
  sports: Fantasy402SportEntry[],
): string {
  return sha256HexOfStableJson(
    canonicalCollisionSet(deriveCollisionsFromSports(sports)),
  );
}

export function deriveCollisionsFromSports(
  sports: Fantasy402SportEntry[],
): Fantasy402CollisionEntry[] {
  const map = findGlobalSubSportCodeCollisions(sports);
  return [...map.entries()]
    .map(([code, sportList]) => ({ code, sports: sportList }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function canonicalCollisionSet(
  collisions: Fantasy402CollisionEntry[],
): { code: string; sports: string[] }[] {
  return collisions
    .map((c) => ({ code: c.code, sports: [...c.sports].sort() }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function subSportPath(sport: string, code: string): string {
  return `${sport}/${code}`;
}

export function allExpectedEmptyPaths(
  cfg: ExpectedEmptySubSportPaths,
): string[] {
  return [...cfg.stable, ...cfg.volatile].sort();
}

/** Configured structural-empty cardinality (never a separate pinned literal). */
export function configuredExpectedEmptySubSportNameCount(
  cfg: ExpectedEmptySubSportPaths,
): number {
  return cfg.stable.length + cfg.volatile.length;
}

function lookupSubSport(
  sports: Fantasy402SportEntry[],
  path: string,
): Fantasy402SubSport | undefined {
  const slash = path.indexOf("/");
  if (slash <= 0) return undefined;
  const sport = path.slice(0, slash);
  const code = path.slice(slash + 1);
  const entry = sports.find((s) => s.sport === sport);
  return entry?.subSports.find((sub) => sub.code === code);
}

export function analyzeEmptySubSportNames(
  catalog: Fantasy402SportCatalog,
): EmptySubSportNameAnalysis {
  const expectedSet = new Set(
    catalog.expectedEmptySubSportPaths
      ? allExpectedEmptyPaths(catalog.expectedEmptySubSportPaths)
      : [],
  );

  const expectedEmptyPaths: string[] = [];
  const unexpectedEmptyPaths: string[] = [];
  const expectedPathsFilled: { path: string; name: string }[] = [];

  for (const entry of catalog.sports) {
    for (const sub of entry.subSports) {
      const path = subSportPath(entry.sport, sub.code);
      const empty = sub.name.trim() === "";
      if (empty) {
        if (expectedSet.has(path)) expectedEmptyPaths.push(path);
        else unexpectedEmptyPaths.push(path);
      } else if (expectedSet.has(path)) {
        expectedPathsFilled.push({ path, name: sub.name });
      }
    }
  }

  expectedEmptyPaths.sort();
  unexpectedEmptyPaths.sort();

  const missingExpectedEmptyPaths: string[] = [];
  for (const path of expectedSet) {
    const sub = lookupSubSport(catalog.sports, path);
    if (!sub) missingExpectedEmptyPaths.push(path);
  }
  missingExpectedEmptyPaths.sort();

  const configured = configuredExpectedEmptySubSportNameCount(
    catalog.expectedEmptySubSportPaths,
  );

  return {
    expectedEmptySubSportNameCount: expectedEmptyPaths.length,
    unexpectedEmptySubSportNameCount: unexpectedEmptyPaths.length,
    configuredExpectedEmptySubSportNameCount: configured,
    expectedEmptyPaths,
    unexpectedEmptyPaths,
    expectedPathsFilled,
    missingExpectedEmptyPaths,
  };
}

/** LIVE pseudo-sport surface (subSports identity), ignoring capture timestamps. */
export function liveSportSurfaceChanged(
  fixture: Fantasy402SportCatalog,
  probe: Fantasy402SportCatalog,
): boolean {
  const fLive = fixture.sports.find((s) => s.sport === "LIVE");
  const pLive = probe.sports.find((s) => s.sport === "LIVE");
  if (!fLive && !pLive) return false;
  if (!fLive || !pLive) return true;

  const fingerprint = (entry: Fantasy402SportEntry): string =>
    [...entry.subSports]
      .map((sub) => `${sub.code}\0${sub.name}`)
      .sort()
      .join("\n");

  return fingerprint(fLive) !== fingerprint(pLive);
}

export function diffEmptySubSportNameAnalysis(
  fixture: EmptySubSportNameAnalysis,
  probe: EmptySubSportNameAnalysis,
): string {
  const parts: string[] = [];
  if (
    probe.unexpectedEmptySubSportNameCount >
    fixture.unexpectedEmptySubSportNameCount
  ) {
    const added = probe.unexpectedEmptyPaths.filter(
      (p) => !fixture.unexpectedEmptyPaths.includes(p),
    );
    parts.push(`+unexpected (${added.join(", ") || "?"})`);
  }
  const filled = probe.expectedPathsFilled.filter(
    (p) => !fixture.expectedPathsFilled.some((f) => f.path === p.path),
  );
  for (const f of filled) {
    parts.push(`FILLED (regression): ${f.path} → "${f.name}"`);
  }
  const removedStructural = fixture.expectedEmptyPaths.filter(
    (p) => !probe.expectedEmptyPaths.includes(p),
  );
  for (const p of removedStructural) {
    parts.push(`REMOVED structural empty: ${p}`);
  }
  return parts.length > 0 ? parts.join("; ") : "unchanged";
}

export function emptyNameQualityRegression(
  fixture: EmptySubSportNameAnalysis,
  probe: EmptySubSportNameAnalysis,
): boolean {
  if (
    probe.unexpectedEmptySubSportNameCount >
    fixture.unexpectedEmptySubSportNameCount
  ) {
    return true;
  }
  if (probe.expectedPathsFilled.length > fixture.expectedPathsFilled.length) {
    return true;
  }
  return probe.expectedPathsFilled.some(
    (p) => !fixture.expectedPathsFilled.some((f) => f.path === p.path),
  );
}

export function uniquePeriodTemplateKeys(
  catalog: Fantasy402SportCatalog,
): string[] {
  const keys = new Set(catalog.sports.map((s) => periodTemplateKey(s.periods)));
  return [...keys].sort();
}

export function findGlobalSubSportCodeCollisions(
  sports: Fantasy402SportEntry[],
): Map<string, string[]> {
  const byCode = new Map<string, Set<string>>();
  for (const entry of sports) {
    for (const sub of entry.subSports) {
      let set = byCode.get(sub.code);
      if (!set) {
        set = new Set();
        byCode.set(sub.code, set);
      }
      set.add(entry.sport);
    }
  }
  const collisions = new Map<string, string[]>();
  for (const [code, sportSet] of byCode) {
    if (sportSet.size > 1) {
      collisions.set(code, [...sportSet].sort());
    }
  }
  return collisions;
}

export function validateFantasy402SportCatalog(
  catalog: Fantasy402SportCatalog,
  opts?: { strictHeader?: boolean },
): CatalogValidationResult {
  const issues: CatalogValidationIssue[] = [];
  const sportCount = catalog.sports.length;
  const subSportCount = catalog.sports.reduce(
    (n, s) => n + s.subSports.length,
    0,
  );
  const sportPeriodCount = catalog.sports.reduce(
    (n, s) => n + s.periods.length,
    0,
  );

  if (catalog.sportCount !== sportCount) {
    issues.push({
      kind: "count_mismatch",
      field: "sportCount",
      declared: catalog.sportCount,
      computed: sportCount,
    });
  }
  if (catalog.subSportCount !== subSportCount) {
    issues.push({
      kind: "count_mismatch",
      field: "subSportCount",
      declared: catalog.subSportCount,
      computed: subSportCount,
    });
  }
  if (
    catalog.sportPeriodCount !== undefined &&
    catalog.sportPeriodCount !== sportPeriodCount
  ) {
    issues.push({
      kind: "count_mismatch",
      field: "sportPeriodCount",
      declared: catalog.sportPeriodCount,
      computed: sportPeriodCount,
    });
  }

  for (const entry of catalog.sports) {
    const seen = new Set<string>();
    for (const sub of entry.subSports) {
      if (seen.has(sub.code)) {
        issues.push({
          kind: "duplicate_code_in_sport",
          sport: entry.sport,
          code: sub.code,
        });
      }
      seen.add(sub.code);
    }

    const sorted = [...entry.periods].sort((a, b) => a.number - b.number);
    const actualNumbers = sorted.map((p) => p.number);
    const expectedNumbers = sorted.map((_, i) => i);
    if (actualNumbers.some((n, i) => n !== expectedNumbers[i])) {
      issues.push({
        kind: "period_number_mismatch",
        sport: entry.sport,
        expectedNumbers,
        actualNumbers,
      });
    }
    const game = sorted.find((p) => p.number === 0);
    if (!game || game.name !== "Game") {
      issues.push({ kind: "missing_game_period", sport: entry.sport });
    }
  }

  if (catalog.periodsCapturedAt) {
    const subSportAt = Date.parse(catalog.capturedAt);
    const periodsAt = Date.parse(catalog.periodsCapturedAt);
    if (
      Number.isFinite(subSportAt) &&
      Number.isFinite(periodsAt) &&
      subSportAt > periodsAt
    ) {
      issues.push({
        kind: "inverted_timestamp",
        capturedAt: catalog.capturedAt,
        periodsCapturedAt: catalog.periodsCapturedAt,
      });
    }
  }

  if (
    !catalog.expectedEmptySubSportPaths ||
    (catalog.expectedEmptySubSportPaths.stable.length === 0 &&
      catalog.expectedEmptySubSportPaths.volatile.length === 0)
  ) {
    issues.push({ kind: "missing_expected_empty_paths_config" });
  } else {
    const emptyAnalysis = analyzeEmptySubSportNames(catalog);
    for (const path of emptyAnalysis.expectedEmptyPaths) {
      issues.push({ kind: "structural_empty_subsport", path });
    }
    for (const path of emptyAnalysis.unexpectedEmptyPaths) {
      issues.push({ kind: "unexpected_empty_subsport", path });
    }
    for (const filled of emptyAnalysis.expectedPathsFilled) {
      issues.push({
        kind: "expected_empty_path_filled",
        path: filled.path,
        name: filled.name,
      });
    }
    for (const path of emptyAnalysis.missingExpectedEmptyPaths) {
      issues.push({ kind: "missing_expected_empty_path", path });
    }
    if (
      emptyAnalysis.expectedEmptySubSportNameCount !==
      emptyAnalysis.configuredExpectedEmptySubSportNameCount
    ) {
      issues.push({
        kind: "expected_empty_count_drift",
        configured: emptyAnalysis.configuredExpectedEmptySubSportNameCount,
        observedInTree: emptyAnalysis.expectedEmptySubSportNameCount,
      });
    }
  }

  const observed = deriveCollisionsFromSports(catalog.sports);
  if (catalog.collisions.length === 0 && observed.length > 0) {
    issues.push({ kind: "missing_collision_registry" });
  } else if (catalog.collisions.length > 0) {
    const declared = canonicalCollisionSet(catalog.collisions);
    const observedNorm = canonicalCollisionSet(observed);
    const declaredJson = stableStringify(declared);
    const observedJson = stableStringify(observedNorm);
    if (declaredJson !== observedJson) {
      const declaredByCode = new Map(declared.map((c) => [c.code, c.sports]));
      const observedByCode = new Map(
        observedNorm.map((c) => [c.code, c.sports]),
      );
      for (const code of new Set([
        ...declaredByCode.keys(),
        ...observedByCode.keys(),
      ])) {
        const d = declaredByCode.get(code) ?? [];
        const o = observedByCode.get(code) ?? [];
        if (d.join("\0") !== o.join("\0")) {
          issues.push({
            kind: "collision_registry_mismatch",
            code,
            observedSports: o,
            declaredSports: d,
          });
        }
      }
    }
  }

  const blocking = issues.filter(
    (i) =>
      i.kind === "duplicate_code_in_sport" ||
      i.kind === "period_number_mismatch" ||
      i.kind === "missing_game_period" ||
      i.kind === "inverted_timestamp" ||
      i.kind === "collision_registry_mismatch" ||
      i.kind === "missing_collision_registry" ||
      i.kind === "missing_expected_empty_paths_config" ||
      i.kind === "unexpected_empty_subsport" ||
      i.kind === "expected_empty_path_filled" ||
      i.kind === "missing_expected_empty_path" ||
      i.kind === "expected_empty_count_drift" ||
      (opts?.strictHeader === true && i.kind === "count_mismatch"),
  );

  return {
    ok: blocking.length === 0,
    issues,
    computed: { sportCount, subSportCount, sportPeriodCount },
  };
}

export function computeCatalogProvenance(
  catalog: Fantasy402SportCatalog,
): CatalogProvenance {
  const periodTemplateBySport: Record<string, string> = {};
  for (const entry of catalog.sports) {
    periodTemplateBySport[entry.sport] = periodTemplateKey(entry.periods);
  }
  const sportPeriodCount = catalog.sports.reduce(
    (n, s) => n + s.periods.length,
    0,
  );
  const subSportCount = catalog.sports.reduce(
    (n, s) => n + s.subSports.length,
    0,
  );
  const registry =
    catalog.collisions.length > 0
      ? catalog.collisions
      : deriveCollisionsFromSports(catalog.sports);
  return {
    digests: {
      subSportTreeSha256Hex: sha256HexOfStableJson(
        canonicalSubSportTree(catalog.sports),
      ),
      periodMenusSha256Hex: sha256HexOfStableJson(
        canonicalPeriodMenus(catalog.sports),
      ),
      collisionRegistrySha256Hex: sha256HexOfStableJson(
        canonicalCollisionSet(registry),
      ),
      observedCollisionSetSha256Hex: observedCollisionSetSha256Hex(
        catalog.sports,
      ),
    },
    metrics: {
      emptyNames: analyzeEmptySubSportNames(catalog),
      expectedEmptyPathsSha256Hex: sha256HexOfStableJson(
        catalog.expectedEmptySubSportPaths
          ? allExpectedEmptyPaths(catalog.expectedEmptySubSportPaths)
          : [],
      ),
      computedCounts: {
        sportCount: catalog.sports.length,
        subSportCount,
        sportPeriodCount,
      },
      periodTemplateBySport,
    },
  };
}

/** Flat view for legacy callers / JSON export. */
export function computeCatalogProvenanceDigests(
  catalog: Fantasy402SportCatalog,
): CatalogProvenanceDigests {
  const p = computeCatalogProvenance(catalog);
  return {
    ...p.digests,
    ...p.metrics,
    collisionSetSha256Hex: p.digests.collisionRegistrySha256Hex,
    emptySubSportNameCount:
      p.metrics.emptyNames.expectedEmptySubSportNameCount +
      p.metrics.emptyNames.unexpectedEmptySubSportNameCount,
  };
}

export async function loadFantasy402SportCatalogFromFile(
  path: string,
): Promise<Fantasy402SportCatalog> {
  const raw: unknown = await Bun.file(path).json();
  return parseFantasy402SportCatalog(raw).catalog;
}

export type CatalogStructuralIssue = {
  path: string;
  message: string;
};

export type CatalogParseResult = {
  catalog: Fantasy402SportCatalog;
  structuralIssues: CatalogStructuralIssue[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseFantasy402SportCatalog(raw: unknown): CatalogParseResult {
  const structuralIssues: CatalogStructuralIssue[] = [];

  if (!isRecord(raw)) {
    structuralIssues.push({ path: "$", message: "root must be an object" });
    throw new Error("Invalid catalog JSON: root must be an object");
  }

  if (raw.valid_from !== undefined) {
    throw new Error(
      "valid_from is not accepted; use capturedAt (interval valid_from is reserved for bitemporal ingestion)",
    );
  }
  if (raw.fetched_at !== undefined) {
    throw new Error(
      "fetched_at is not accepted; use periodsCapturedAt for period-menu capture time",
    );
  }

  const provider = raw.provider;
  const capturedAt = raw.capturedAt;
  if (typeof provider !== "string" || provider.length === 0) {
    structuralIssues.push({ path: "provider", message: "required string" });
  }
  if (typeof capturedAt !== "string" || capturedAt.length === 0) {
    structuralIssues.push({ path: "capturedAt", message: "required string" });
  }

  const sportsRaw = raw.sports;
  if (!Array.isArray(sportsRaw)) {
    structuralIssues.push({ path: "sports", message: "required array" });
    throw new Error("Invalid catalog JSON: sports must be an array");
  }

  const sports: Fantasy402SportEntry[] = [];
  for (let si = 0; si < sportsRaw.length; si++) {
    const s = sportsRaw[si];
    const base = `sports[${si}]`;
    if (!isRecord(s)) {
      structuralIssues.push({ path: base, message: "must be an object" });
      continue;
    }
    if (typeof s.sport !== "string") {
      structuralIssues.push({
        path: `${base}.sport`,
        message: "required string",
      });
    }
    const subSports: Fantasy402SubSport[] = [];
    if (!Array.isArray(s.subSports)) {
      structuralIssues.push({
        path: `${base}.subSports`,
        message: "required array",
      });
    } else {
      for (let i = 0; i < s.subSports.length; i++) {
        const sub = s.subSports[i];
        const p = `${base}.subSports[${i}]`;
        if (!isRecord(sub)) {
          structuralIssues.push({ path: p, message: "must be an object" });
          continue;
        }
        if (typeof sub.code !== "string" || typeof sub.name !== "string") {
          structuralIssues.push({
            path: p,
            message: "code and name must be strings",
          });
          continue;
        }
        subSports.push({ code: sub.code, name: sub.name });
      }
    }
    const periods: Fantasy402Period[] = [];
    if (!Array.isArray(s.periods)) {
      structuralIssues.push({
        path: `${base}.periods`,
        message: "required array",
      });
    } else {
      for (let i = 0; i < s.periods.length; i++) {
        const per = s.periods[i];
        const p = `${base}.periods[${i}]`;
        if (!isRecord(per)) {
          structuralIssues.push({ path: p, message: "must be an object" });
          continue;
        }
        if (typeof per.name !== "string" || typeof per.number !== "number") {
          structuralIssues.push({
            path: p,
            message: "name string and number required",
          });
          continue;
        }
        periods.push({ name: per.name, number: per.number });
      }
    }
    sports.push({
      sport: typeof s.sport === "string" ? s.sport : "",
      subSports,
      periods,
    });
  }

  if (structuralIssues.length > 0) {
    throw new Error(
      `Invalid catalog JSON: ${structuralIssues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  }

  const sportCount =
    typeof raw.sportCount === "number" ? raw.sportCount : sports.length;
  const subSportCount =
    typeof raw.subSportCount === "number"
      ? raw.subSportCount
      : sports.reduce((n, e) => n + e.subSports.length, 0);

  let expectedEmptySubSportPaths: ExpectedEmptySubSportPaths = {
    stable: [],
    volatile: [],
  };
  if (isRecord(raw.expectedEmptySubSportPaths)) {
    const cfg = raw.expectedEmptySubSportPaths;
    if (Array.isArray(cfg.stable)) {
      expectedEmptySubSportPaths.stable = cfg.stable.filter(
        (s): s is string => typeof s === "string",
      );
    }
    if (Array.isArray(cfg.volatile)) {
      expectedEmptySubSportPaths.volatile = cfg.volatile.filter(
        (s): s is string => typeof s === "string",
      );
    }
  }

  const migrationRisks: CatalogMigrationRisk[] = [];
  if (Array.isArray(raw.migrationRisks)) {
    for (const item of raw.migrationRisks) {
      if (!isRecord(item)) continue;
      if (typeof item.kind !== "string" || typeof item.note !== "string") {
        continue;
      }
      migrationRisks.push({
        kind: item.kind,
        note: item.note,
        ...(typeof item.code === "string" ? { code: item.code } : {}),
        ...(Array.isArray(item.affects)
          ? {
              affects: item.affects.filter(
                (a): a is string => typeof a === "string",
              ),
            }
          : {}),
      });
    }
  }

  const collisions: Fantasy402CollisionEntry[] = [];
  if (Array.isArray(raw.collisions)) {
    for (const item of raw.collisions) {
      if (!isRecord(item)) continue;
      if (typeof item.code !== "string" || !Array.isArray(item.sports))
        continue;
      collisions.push({
        code: item.code,
        sports: item.sports.filter((s): s is string => typeof s === "string"),
      });
    }
  }

  const catalog: Fantasy402SportCatalog = {
    provider: provider as string,
    capturedAt: capturedAt as string,
    sportCount,
    subSportCount,
    sports,
    collisions,
    expectedEmptySubSportPaths,
  };
  if (migrationRisks.length > 0) {
    catalog.migrationRisks = migrationRisks;
  }
  if (typeof raw.periodsCapturedAt === "string") {
    catalog.periodsCapturedAt = raw.periodsCapturedAt;
  }
  if (typeof raw.sportPeriodCount === "number") {
    catalog.sportPeriodCount = raw.sportPeriodCount;
  }

  return { catalog, structuralIssues: [] };
}

export function normalizeCatalogCounts(
  catalog: Fantasy402SportCatalog,
): Fantasy402SportCatalog {
  const sportPeriodCount = catalog.sports.reduce(
    (n, s) => n + s.periods.length,
    0,
  );
  return {
    ...catalog,
    sportCount: catalog.sports.length,
    subSportCount: catalog.sports.reduce((n, s) => n + s.subSports.length, 0),
    sportPeriodCount,
  };
}

export type CatalogProposedRefresh = Fantasy402SportCatalog & {
  proposedCollisions: Fantasy402CollisionEntry[];
};

export function buildProposedCatalogRefresh(
  catalog: Fantasy402SportCatalog,
): CatalogProposedRefresh {
  const normalized = normalizeCatalogCounts(catalog);
  return {
    ...normalized,
    proposedCollisions: deriveCollisionsFromSports(normalized.sports),
  };
}

export function applyForcedCollisionRegistry(
  catalog: Fantasy402SportCatalog,
): Fantasy402SportCatalog {
  return {
    ...normalizeCatalogCounts(catalog),
    collisions: deriveCollisionsFromSports(catalog.sports),
  };
}

export type CatalogSubSportNameChange = {
  code: string;
  fixtureName: string;
  probeName: string;
};

export type CatalogSportDiff = {
  sport: string;
  subSportsAdded: Fantasy402SubSport[];
  subSportsRemoved: Fantasy402SubSport[];
  subSportNameChanges: CatalogSubSportNameChange[];
  periodsChanged: boolean;
  fixturePeriodTemplate: string;
  probePeriodTemplate: string;
};

export type CatalogDiff = {
  fixture: {
    capturedAt: string;
    periodsCapturedAt?: string;
    digests: CatalogProvenanceDigests;
  };
  probe: {
    capturedAt: string;
    periodsCapturedAt?: string;
    digests: CatalogProvenanceDigests;
  };
  subSportTreeChanged: boolean;
  periodMenusChanged: boolean;
  sportsAdded: string[];
  sportsRemoved: string[];
  sportChanges: CatalogSportDiff[];
  hasChanges: boolean;
};

function subSportByCode(
  subSports: Fantasy402SubSport[],
): Map<string, Fantasy402SubSport> {
  return new Map(subSports.map((s) => [s.code, s]));
}

export function diffFantasy402SportCatalogs(
  fixture: Fantasy402SportCatalog,
  probe: Fantasy402SportCatalog,
): CatalogDiff {
  const fixtureDigests = computeCatalogProvenanceDigests(fixture);
  const probeDigests = computeCatalogProvenanceDigests(probe);

  const fixtureSports = new Map(fixture.sports.map((s) => [s.sport, s]));
  const probeSports = new Map(probe.sports.map((s) => [s.sport, s]));

  const sportsAdded = [...probeSports.keys()]
    .filter((s) => !fixtureSports.has(s))
    .sort();
  const sportsRemoved = [...fixtureSports.keys()]
    .filter((s) => !probeSports.has(s))
    .sort();

  const sportChanges: CatalogSportDiff[] = [];
  for (const sport of [...fixtureSports.keys()].sort()) {
    if (!probeSports.has(sport)) continue;
    const f = fixtureSports.get(sport)!;
    const p = probeSports.get(sport)!;
    const fMap = subSportByCode(f.subSports);
    const pMap = subSportByCode(p.subSports);

    const subSportsAdded: Fantasy402SubSport[] = [];
    const subSportsRemoved: Fantasy402SubSport[] = [];
    const subSportNameChanges: CatalogSubSportNameChange[] = [];

    for (const [code, sub] of pMap) {
      if (!fMap.has(code)) subSportsAdded.push(sub);
      else if (fMap.get(code)!.name !== sub.name) {
        subSportNameChanges.push({
          code,
          fixtureName: fMap.get(code)!.name,
          probeName: sub.name,
        });
      }
    }
    for (const [code, sub] of fMap) {
      if (!pMap.has(code)) subSportsRemoved.push(sub);
    }

    subSportsAdded.sort((a, b) => a.code.localeCompare(b.code));
    subSportsRemoved.sort((a, b) => a.code.localeCompare(b.code));
    subSportNameChanges.sort((a, b) => a.code.localeCompare(b.code));

    const fixturePeriodTemplate = periodTemplateKey(f.periods);
    const probePeriodTemplate = periodTemplateKey(p.periods);
    const periodsChanged = fixturePeriodTemplate !== probePeriodTemplate;

    if (
      subSportsAdded.length > 0 ||
      subSportsRemoved.length > 0 ||
      subSportNameChanges.length > 0 ||
      periodsChanged
    ) {
      sportChanges.push({
        sport,
        subSportsAdded,
        subSportsRemoved,
        subSportNameChanges,
        periodsChanged,
        fixturePeriodTemplate,
        probePeriodTemplate,
      });
    }
  }

  for (const sport of sportsAdded) {
    const p = probeSports.get(sport)!;
    sportChanges.push({
      sport,
      subSportsAdded: [...p.subSports].sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
      subSportsRemoved: [],
      subSportNameChanges: [],
      periodsChanged: true,
      fixturePeriodTemplate: "",
      probePeriodTemplate: periodTemplateKey(p.periods),
    });
  }

  sportChanges.sort((a, b) => a.sport.localeCompare(b.sport));

  const subSportTreeChanged =
    fixtureDigests.subSportTreeSha256Hex !== probeDigests.subSportTreeSha256Hex;
  const periodMenusChanged =
    fixtureDigests.periodMenusSha256Hex !== probeDigests.periodMenusSha256Hex;

  const collisionSetChanged =
    fixtureDigests.observedCollisionSetSha256Hex !==
    probeDigests.observedCollisionSetSha256Hex;
  const emptyNamesIncreased =
    probeDigests.emptyNames.unexpectedEmptySubSportNameCount >
      fixtureDigests.emptyNames.unexpectedEmptySubSportNameCount ||
    probeDigests.emptyNames.expectedPathsFilled.length >
      fixtureDigests.emptyNames.expectedPathsFilled.length;

  const hasChanges =
    subSportTreeChanged ||
    periodMenusChanged ||
    collisionSetChanged ||
    emptyNamesIncreased ||
    sportsAdded.length > 0 ||
    sportsRemoved.length > 0 ||
    sportChanges.length > 0;

  return {
    fixture: {
      capturedAt: fixture.capturedAt,
      ...(fixture.periodsCapturedAt !== undefined
        ? { periodsCapturedAt: fixture.periodsCapturedAt }
        : {}),
      digests: fixtureDigests,
    },
    probe: {
      capturedAt: probe.capturedAt,
      ...(probe.periodsCapturedAt !== undefined
        ? { periodsCapturedAt: probe.periodsCapturedAt }
        : {}),
      digests: probeDigests,
    },
    subSportTreeChanged,
    periodMenusChanged,
    sportsAdded,
    sportsRemoved,
    sportChanges,
    hasChanges,
  };
}

export class CatalogProbeFetchError extends Error {
  readonly kind: "timeout" | "http" | "network";
  constructor(kind: CatalogProbeFetchError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export async function loadFantasy402SportCatalogFromProbe(
  source: string,
  opts?: { timeoutMs?: number },
): Promise<Fantasy402SportCatalog> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  let raw: unknown;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    try {
      const res = await fetch(source, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new CatalogProbeFetchError(
          "http",
          `Probe fetch failed: HTTP ${res.status} ${source}`,
        );
      }
      raw = await res.json();
    } catch (e) {
      if (e instanceof CatalogProbeFetchError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Timeout") || msg.includes("timeout")) {
        throw new CatalogProbeFetchError(
          "timeout",
          `Probe fetch timed out after ${timeoutMs}ms: ${source}`,
        );
      }
      throw new CatalogProbeFetchError("network", msg);
    }
  } else if (source.startsWith("file://")) {
    raw = await Bun.file(new URL(source)).json();
  } else {
    raw = await Bun.file(source).json();
  }
  return parseFantasy402SportCatalog(raw).catalog;
}
