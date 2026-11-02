/**
 * Internal consistency of `docs/evidence/ledger.json` against itself and the published spec.
 *
 * The ledger is the SSOT for what is verified, observed or inferred, and the docs gate trusts
 * it. Nothing checked the ledger against *itself*, so three defects sat in it unnoticed:
 *
 * - `schemaDoc.counts` prose said "A+B+C+D+E = total = 48" while `counts.total` and the rows
 *   said 55. Prose is not derived from anything, so it drifted the moment rows were added.
 * - `surface.missingFromSpec` had no stated meaning, so four rows disagreed about it: some read
 *   it as "no member path is published", others as "some member path is not published".
 * - The counts themselves (`counts`, `surfaceCounts`, `countsByTag`) are hand-maintained
 *   duplicates of the row tiers.
 *
 * This module derives all of it and reports what disagrees. It never edits the ledger: a
 * generator that silently rewrites an evidence file is worse than a failing check.
 */

export type Issue = {
  readonly code:
    | "COUNTS_STALE"
    | "PROSE_STALE"
    | "SURFACE_FLAG_WRONG"
    | "SURFACE_FLAG_UNDOCUMENTED"
    | "SHAPE";
  readonly message: string;
};

type Json = Record<string, unknown>;

const TIERS = ["A", "B", "C", "D", "E"] as const;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip a leading `METHOD ` and a trailing `/*`, so a surface member reduces to a spec path. */
export function memberPath(member: unknown): string | undefined {
  if (typeof member !== "string") return undefined;
  const trimmed = member
    .trim()
    .replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, "");
  const path = trimmed.split(/\s+/)[0] ?? "";
  if (!path.startsWith("/")) return undefined;
  return path.replace(/\/\*$/, "");
}

/**
 * Whether a surface is missing from the spec, derived rather than declared.
 *
 * False means: the spec publishes every path this surface lists, and it lists at least one.
 * True means anything else — a surface whose members are field names or CLI commands rather
 * than routes is missing by construction, because the spec models operations, not tooling.
 */
export function deriveMissingFromSpec(
  surface: Json,
  specPaths: ReadonlySet<string>,
): boolean {
  const members = Array.isArray(surface["members"]) ? surface["members"] : [];
  const paths = members
    .map(memberPath)
    .filter((p): p is string => p !== undefined);
  if (paths.length === 0) return true;
  return paths.some((path) => !specPaths.has(path));
}

/** Tier counts over `operations[]`, recomputed from the rows. */
export function countTiers(rows: readonly unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const tier = typeof row["tier"] === "string" ? row["tier"] : "";
    if (tier === "") continue;
    counts[tier] = (counts[tier] ?? 0) + 1;
  }
  return counts;
}

function totalOf(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function specPathsOf(spec: unknown): Set<string> {
  if (!isRecord(spec) || !isRecord(spec["paths"])) return new Set();
  return new Set(Object.keys(spec["paths"]));
}

/**
 * Every disagreement between the ledger's declared bookkeeping and its own rows.
 *
 * `spec` may be undefined when the spec is unavailable; the surface-flag checks are then
 * skipped rather than guessed, and the caller sees fewer issues, not false ones.
 */
export function auditLedger(ledger: unknown, spec?: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isRecord(ledger)) {
    return [{ code: "SHAPE", message: "ledger is not a JSON object" }];
  }
  const operations = Array.isArray(ledger["operations"])
    ? ledger["operations"]
    : [];
  const surfaces = Array.isArray(ledger["surfaces"]) ? ledger["surfaces"] : [];

  // 1. counts.total must agree with counts.A..E and with the rows.
  const declared = isRecord(ledger["counts"]) ? ledger["counts"] : {};
  const actual = countTiers(operations);
  for (const tier of TIERS) {
    const want = typeof declared[tier] === "number" ? declared[tier] : 0;
    const have = actual[tier] ?? 0;
    if (want !== have) {
      issues.push({
        code: "COUNTS_STALE",
        message: `counts.${tier}=${want} but ${have} operations[] row(s) are tier ${tier}`,
      });
    }
  }
  const declaredTotal =
    typeof declared["total"] === "number" ? declared["total"] : 0;
  if (declaredTotal !== operations.length) {
    issues.push({
      code: "COUNTS_STALE",
      message: `counts.total=${declaredTotal} but operations[] has ${operations.length} row(s)`,
    });
  }

  // 2. surfaceCounts must agree with surfaces[].
  const declaredSurfaces = isRecord(ledger["surfaceCounts"])
    ? ledger["surfaceCounts"]
    : {};
  const actualSurfaces = countTiers(surfaces);
  for (const tier of ["D", "E"] as const) {
    const want =
      typeof declaredSurfaces[tier] === "number" ? declaredSurfaces[tier] : 0;
    const have = actualSurfaces[tier] ?? 0;
    if (want !== have) {
      issues.push({
        code: "COUNTS_STALE",
        message: `surfaceCounts.${tier}=${want} but ${have} surfaces[] row(s) are tier ${tier}`,
      });
    }
  }
  const declaredSurfaceTotal =
    typeof declaredSurfaces["total"] === "number"
      ? declaredSurfaces["total"]
      : 0;
  if (declaredSurfaceTotal !== surfaces.length) {
    issues.push({
      code: "COUNTS_STALE",
      message: `surfaceCounts.total=${declaredSurfaceTotal} but surfaces[] has ${surfaces.length} row(s)`,
    });
  }

  // 3. The schemaDoc prose restates the arithmetic, so it is a copy that can go stale. It said
  //    "total = 48" for 55 rows, which is why this check exists.
  const schemaDoc = isRecord(ledger["schemaDoc"]) ? ledger["schemaDoc"] : {};
  const prose =
    typeof schemaDoc["counts"] === "string" ? schemaDoc["counts"] : "";
  const claimedTotal = /=\s*total\s*=\s*(\d+)/.exec(prose)?.[1];
  if (claimedTotal !== undefined && Number(claimedTotal) !== totalOf(actual)) {
    issues.push({
      code: "PROSE_STALE",
      message: `schemaDoc.counts says "total = ${claimedTotal}" but operations[] holds ${totalOf(actual)}`,
    });
  }

  // 4. The surface flag must mean what the field description says, and be documented at all.
  const surfaceFields = isRecord(schemaDoc["surfaceFields"])
    ? schemaDoc["surfaceFields"]
    : {};
  if (!("missingFromSpec" in surfaceFields)) {
    issues.push({
      code: "SURFACE_FLAG_UNDOCUMENTED",
      message:
        'schemaDoc.surfaceFields has no "missingFromSpec" entry; an undocumented boolean is what let four rows disagree about its meaning',
    });
  }
  if (spec !== undefined) {
    const specPaths = specPathsOf(spec);
    for (const surface of surfaces) {
      if (!isRecord(surface)) continue;
      const declaredFlag = surface["missingFromSpec"];
      if (typeof declaredFlag !== "boolean") continue;
      const derived = deriveMissingFromSpec(surface, specPaths);
      if (declaredFlag !== derived) {
        issues.push({
          code: "SURFACE_FLAG_WRONG",
          message: `${String(surface["id"] ?? surface["name"] ?? "surface")}: missingFromSpec=${declaredFlag} but the spec says ${derived} (${describeMembers(surface, specPaths)})`,
        });
      }
    }
  }

  return issues;
}

function describeMembers(
  surface: Json,
  specPaths: ReadonlySet<string>,
): string {
  const members = Array.isArray(surface["members"]) ? surface["members"] : [];
  const paths = members
    .map(memberPath)
    .filter((p): p is string => p !== undefined);
  if (paths.length === 0) return "no path members";
  const missing = paths.filter((path) => !specPaths.has(path));
  if (missing.length === 0)
    return `all ${paths.length} path member(s) published`;
  return `${missing.length}/${paths.length} path member(s) absent: ${missing.slice(0, 3).join(", ")}`;
}
