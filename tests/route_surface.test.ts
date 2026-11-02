import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  compareRouteSurfaces,
  declaredPathsFromLedger,
  memberPath,
  readRouteSurfaceInputs,
  servedPathsFromSource,
  specPathsFromDocument,
} from "../lib/route_surface.ts";

/**
 * The daemon's surface was maintained three times by hand — 43 `pathname ===` arms, the ledger's
 * `surfaces[].members`, and the spec's `paths` — with nothing comparing them. Measured
 * 2026-11-01: five served `/api` routes appeared in neither the ledger nor the spec.
 */

const ROOT = resolve(import.meta.dir, "..");

describe("memberPath", () => {
  test("strips a method prefix and keeps the path", () => {
    expect(memberPath("GET /api/scoreboard")).toBe("/api/scoreboard");
    expect(memberPath("/api/live-bets")).toBe("/api/live-bets");
    expect(memberPath("OPTIONS *")).toBeUndefined();
    expect(memberPath(42)).toBeUndefined();
  });
});

describe("servedPathsFromSource", () => {
  test("reads literal comparisons, including the two arms on one line", () => {
    const source = `
      if (pathname === "/api/status" || pathname === "/status.json") {}
      if (pathname === "/api/telegram/alert" && req.method === "POST") {}
    `;
    expect([...servedPathsFromSource(source)].sort()).toEqual([
      "/api/status",
      "/api/telegram/alert",
      "/status.json",
    ]);
  });

  test("ignores non-path literals and query strings", () => {
    expect([
      ...servedPathsFromSource(
        'pathname === "not-a-path"; pathname === "/x?y=1"',
      ),
    ]).toEqual(["/x"]);
  });
});

describe("declaredPathsFromLedger", () => {
  const ledger = {
    surfaces: [
      { id: "surface.local", category: "local-route", members: ["GET /api/a"] },
      {
        id: "surface.upstream",
        category: "upstream-route",
        members: ["GET /cloud/api/b"],
      },
    ],
  };

  test("carries the declaring surface and its category", () => {
    const declared = declaredPathsFromLedger(ledger);
    expect(declared.get("/api/a")).toEqual({
      surface: "surface.local",
      category: "local-route",
    });
    expect(declared.get("/cloud/api/b")?.category).toBe("upstream-route");
  });

  test("tolerates a ledger with no surfaces", () => {
    expect(declaredPathsFromLedger({}).size).toBe(0);
    expect(declaredPathsFromLedger(null).size).toBe(0);
  });
});

describe("specPathsFromDocument", () => {
  test("reads the published paths and tolerates junk", () => {
    expect(
      [...specPathsFromDocument({ paths: { "/a": {}, "/b": {} } })].sort(),
    ).toEqual(["/a", "/b"]);
    expect(specPathsFromDocument({}).size).toBe(0);
    expect(specPathsFromDocument(null).size).toBe(0);
  });
});

describe("compareRouteSurfaces", () => {
  const declared = new Map([
    ["/api/known", { surface: "surface.local", category: "local-route" }],
    ["/api/gone", { surface: "surface.local", category: "local-route" }],
    [
      "/cloud/api/up",
      { surface: "surface.upstream", category: "upstream-route" },
    ],
  ]);

  test("a served API path with no surface is reported", () => {
    const findings = compareRouteSurfaces({
      served: new Set(["/api/known", "/api/undocumented"]),
      declared,
      spec: new Set(["/api/known"]),
    });
    expect(findings.map((f) => `${f.kind} ${f.path}`)).toContain(
      "served-undocumented /api/undocumented",
    );
  });

  test("a declared API path the daemon no longer serves is reported", () => {
    const findings = compareRouteSurfaces({
      served: new Set(["/api/known"]),
      declared,
      spec: new Set(["/api/known"]),
    });
    expect(findings.map((f) => `${f.kind} ${f.path}`)).toContain(
      "declared-not-served /api/gone",
    );
  });

  test("upstream routes are not expected to be served here", () => {
    const findings = compareRouteSurfaces({
      served: new Set(),
      declared,
      spec: new Set(),
    });
    expect(findings.map((f) => f.path)).not.toContain("/cloud/api/up");
  });

  test("pages are not drift — but a declared page that vanished still is", () => {
    const withPage = new Map([
      ...declared,
      ["/graph", { surface: "surface.graph", category: "local-route" }],
    ]);
    const findings = compareRouteSurfaces({
      served: new Set(),
      declared: withPage,
      spec: new Set(),
    });
    // A served page missing from the ledger is fine (UI, not contract)…
    expect(
      compareRouteSurfaces({
        served: new Set(["/new-page"]),
        declared: withPage,
        spec: new Set(),
      }).map((f) => f.path),
    ).not.toContain("/new-page");
    // …but /graph is a page, so its absence is not asserted by this check either.
    expect(findings.map((f) => f.path)).not.toContain("/graph");
  });

  test("a served and declared API path missing from the spec is reported", () => {
    const findings = compareRouteSurfaces({
      served: new Set(["/api/known"]),
      declared: new Map([
        ["/api/known", { surface: "s", category: "local-route" }],
      ]),
      spec: new Set(),
    });
    expect(findings.map((f) => `${f.kind} ${f.path}`)).toEqual([
      "spec-missing /api/known",
    ]);
  });
});

describe("the committed tree", () => {
  test("every served /api path is declared by a ledger surface", () => {
    const { served, declared, spec } = readRouteSurfaceInputs(ROOT);
    expect(served.size).toBeGreaterThan(20);
    const findings = compareRouteSurfaces({ served, declared, spec });
    const undocumented = findings.filter(
      (f) => f.kind === "served-undocumented",
    );
    expect(undocumented).toEqual([]);
  });

  test("the remaining findings are all spec gaps, and they are counted", () => {
    // Not fixed here: adding eight operations to docs/openapi.json needs a builder per route.
    // Pinned so the number cannot grow silently while the docs pass is pending.
    const { served, declared, spec } = readRouteSurfaceInputs(ROOT);
    const findings = compareRouteSurfaces({ served, declared, spec });
    expect(new Set(findings.map((f) => f.kind))).toEqual(
      new Set(["spec-missing"]),
    );
    expect(findings.length).toBe(8);
  });
});
