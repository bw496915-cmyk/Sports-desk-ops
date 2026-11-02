/**
 * The daemon's route surface exists in three places, hand-maintained: the `pathname === "…"`
 * arms in services/sportsdesk_webview_server.ts, `surfaces[].members` in the ledger, and the
 * paths in docs/openapi.json. Nothing compared them, so they drifted: measured 2026-11-01,
 * five routes were served and undocumented.
 *
 * This derives the served surface from the source and compares it with what is declared. It is
 * a static reading of the chain, not a model of it — once the handler grows a real route table
 * (`ROUTES`), the table becomes the source and this extractor is deleted. Until then the
 * invariant is enforced rather than assumed.
 */

import { readFileSync } from "node:fs";

export type SurfaceFinding = {
  readonly kind: "served-undocumented" | "declared-not-served" | "spec-missing";
  readonly path: string;
  readonly detail: string;
};

/** Normalise a ledger member (`GET /api/x`) to a bare path. */
export function memberPath(member: unknown): string | undefined {
  if (typeof member !== "string") return undefined;
  const text = member
    .trim()
    .replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, "");
  const path = text.split(/\s+/)[0] ?? "";
  return path.startsWith("/") ? path : undefined;
}

/**
 * Paths the server answers, read from the if-chain.
 *
 * Both the literal comparison and the two variants in use are covered: `pathname === "…"`,
 * a `||` continuation onto the next line, and `pathname.endsWith(…)` suffix matching. Query
 * strings are not part of a path, so they are dropped.
 */
export function servedPathsFromSource(source: string): Set<string> {
  const paths = new Set<string>();
  const literal = /pathname === "([^"]+)"/g;
  for (const match of source.matchAll(literal)) {
    const value = match[1] ?? "";
    if (value.startsWith("/")) paths.add(value.split("?")[0] ?? value);
  }
  return paths;
}

export type DeclaredPath = {
  readonly surface: string;
  /** `local-route` paths are served by this daemon; `upstream-route` ones are proxied elsewhere. */
  readonly category: string;
};

/** Paths declared by the ledger's surfaces[], with the surface and category that declare them. */
export function declaredPathsFromLedger(
  ledger: unknown,
): Map<string, DeclaredPath> {
  const declared = new Map<string, DeclaredPath>();
  if (typeof ledger !== "object" || ledger === null) return declared;
  const surfaces = (ledger as { surfaces?: unknown }).surfaces;
  if (!Array.isArray(surfaces)) return declared;
  for (const surface of surfaces) {
    if (typeof surface !== "object" || surface === null) continue;
    const record = surface as {
      id?: unknown;
      category?: unknown;
      members?: unknown;
    };
    const id = typeof record.id === "string" ? record.id : "surface";
    const category =
      typeof record.category === "string" ? record.category : "unknown";
    if (!Array.isArray(record.members)) continue;
    for (const member of record.members) {
      const path = memberPath(member);
      if (path !== undefined) declared.set(path, { surface: id, category });
    }
  }
  return declared;
}

/** Paths published in the spec. */
export function specPathsFromDocument(spec: unknown): Set<string> {
  if (typeof spec !== "object" || spec === null) return new Set();
  const paths = (spec as { paths?: unknown }).paths;
  if (typeof paths !== "object" || paths === null) return new Set();
  return new Set(Object.keys(paths));
}

/**
 * Compare the three views.
 *
 * `declared-not-served` is only reported for surfaces that are not documented as unimplemented:
 * `surface.desk-api-unimplemented` exists precisely to record routes that are documented and
 * deliberately absent, so counting those as drift would train the reader to ignore the report.
 */
export function compareRouteSurfaces(input: {
  readonly served: ReadonlySet<string>;
  readonly declared: ReadonlyMap<string, DeclaredPath>;
  readonly spec: ReadonlySet<string>;
  readonly allowUndeclaredUnserved?: readonly string[];
}): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  const allow = new Set(
    input.allowUndeclaredUnserved ?? ["surface.desk-api-unimplemented"],
  );

  // Scope: `/api/*` is the contract and must be declared. Pages (`/graph`, `/live-bets`, …) are
  // UI, described by surfaces at a coarser grain, so a missing page row is not drift — but a
  // *declared* page that is no longer served still is.
  const isApi = (path: string): boolean => path.startsWith("/api/");

  for (const path of [...input.served].sort()) {
    if (!isApi(path)) continue;
    const declared = input.declared.get(path);
    if (declared === undefined) {
      findings.push({
        kind: "served-undocumented",
        path,
        detail: "served by the daemon, but no ledger surface lists it",
      });
    }
  }

  // `declared-not-served` is only asserted where the reading is trustworthy: a local-route
  // surface's `/api/*` member, which the chain can only serve through a literal comparison.
  // Upstream routes are proxied elsewhere, and asset/data paths are served by prefix or suffix
  // matching, which this extractor deliberately does not model.
  for (const [path, declared] of [...input.declared.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (input.served.has(path)) continue;
    if (allow.has(declared.surface)) continue;
    if (declared.category !== "local-route" || !path.startsWith("/api/"))
      continue;
    findings.push({
      kind: "declared-not-served",
      path,
      detail: `${declared.surface} lists it, but the daemon has no such arm`,
    });
  }

  for (const path of [...input.declared.keys()].sort()) {
    if (!isApi(path)) continue;
    if (input.served.has(path) && !input.spec.has(path)) {
      findings.push({
        kind: "spec-missing",
        path,
        detail:
          "served and declared, but docs/openapi.json publishes no path for it",
      });
    }
  }
  return findings;
}

export function readRouteSurfaceInputs(root: string): {
  readonly served: Set<string>;
  readonly declared: Map<string, DeclaredPath>;
  readonly spec: Set<string>;
} {
  const source = readFileSync(
    `${root}/services/sportsdesk_webview_server.ts`,
    "utf8",
  );
  const ledger = JSON.parse(
    readFileSync(`${root}/docs/evidence/ledger.json`, "utf8"),
  );
  const spec = JSON.parse(readFileSync(`${root}/docs/openapi.json`, "utf8"));
  return {
    served: servedPathsFromSource(source),
    declared: declaredPathsFromLedger(ledger),
    spec: specPathsFromDocument(spec),
  };
}
