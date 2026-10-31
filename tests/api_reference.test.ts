/**
 * docs/api-reference invariants — replaces the old fabricated endpoint list.
 *
 * The previous test hard-coded the invented inventory (including
 * /manager-tools/ajax.php), so it could never fail. These tests instead assert
 * the invariants that made the docs untrustworthy: honest evidence tiers,
 * consistent tags, no fabricated wire contracts, no invented getWebLog
 * response schema, resolvable auth, and the shipped portal/header gates.
 * Negative tests prove the exported validator actually rejects regressions.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkHeaders,
  checkIndexHtml,
  checkMarkdownText,
  checkOpenApi,
  CODES,
  collectOperations,
  collectSecurityRefs,
  isRecord,
  TIERS,
  type CheckOutcome,
  type Operation,
} from "../scripts/verify_docs.ts";

const ROOT = join(import.meta.dir, "..");
const SPEC_PATH = join(ROOT, "docs", "openapi.json");
const MARKDOWN_PATH = join(ROOT, "docs", "api-reference.md");
const INDEX_PATH = join(ROOT, "docs", "index.html");
const HEADERS_PATH = join(ROOT, "functions", "_headers");
const EVIDENCE_MD_PATH = join(ROOT, "docs", "EVIDENCE.md");

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function loadSpec(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readText(SPEC_PATH));
  if (!isRecord(parsed)) {
    throw new Error("docs/openapi.json must be a JSON object");
  }
  return parsed;
}

function specPaths(spec: Record<string, unknown>): Record<string, unknown> {
  const paths = spec.paths;
  if (!isRecord(paths)) throw new Error("spec.paths must be an object");
  return paths;
}

function operationsOf(spec: Record<string, unknown>): Operation[] {
  return collectOperations(spec);
}

function tierOf(operation: Operation): unknown {
  const evidence = operation.operation["x-evidence"];
  return isRecord(evidence) ? evidence.tier : undefined;
}

function findOperation(
  spec: Record<string, unknown>,
  pathPattern: RegExp,
): Operation | undefined {
  return operationsOf(spec).find((operation) =>
    pathPattern.test(operation.path),
  );
}

function requireOperation(
  spec: Record<string, unknown>,
  pathPattern: RegExp,
): Operation {
  const operation = findOperation(spec, pathPattern);
  if (operation === undefined) {
    throw new Error(`no operation path matches ${pathPattern}`);
  }
  return operation;
}

function expectNoIssues(outcome: CheckOutcome): void {
  if (outcome.issues.length > 0 || outcome.status === "fail") {
    const rendered = outcome.issues
      .map((issue) => `  [${issue.code}] ${issue.message}`)
      .join("\n");
    throw new Error(`${outcome.name} failed:\n${rendered}`);
  }
  expect(outcome.status).toBe("pass");
}

function hasContent(response: unknown): boolean {
  return (
    isRecord(response) &&
    Object.prototype.hasOwnProperty.call(response, "content")
  );
}

describe("openapi.json honesty invariants", () => {
  test("is OpenAPI 3.1.0 and keeps the real cloud + local daemon servers", () => {
    const spec = loadSpec();
    expect(spec.openapi).toBe("3.1.0");

    const urls: string[] = [];
    const servers = spec.servers;
    if (Array.isArray(servers)) {
      for (const server of servers) {
        if (isRecord(server) && typeof server.url === "string") {
          urls.push(server.url);
        }
      }
    }
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((url) => url.includes("fantasy402.com"))).toBe(true);
    expect(urls.some((url) => url.includes("127.0.0.1:4020"))).toBe(true);
    expect(urls.some((url) => url.includes("sportswidgets.pro"))).toBe(false);
  });

  test("passes the structural gate with zero issues", () => {
    expectNoIssues(checkOpenApi(loadSpec(), readText(SPEC_PATH)));
  });

  test("every operation declares an evidence tier A|B|C|D", () => {
    const operations = operationsOf(loadSpec());
    expect(operations.length).toBeGreaterThan(0);
    const offenders = operations.filter((operation) => {
      const tier = tierOf(operation);
      return (
        typeof tier !== "string" || !(TIERS as readonly string[]).includes(tier)
      );
    });
    expect(
      offenders.map((operation) => `${operation.method} ${operation.path}`),
    ).toEqual([]);
  });

  test("declared tags equal the tags operations actually use", () => {
    const spec = loadSpec();
    const declared: string[] = [];
    const specTags = spec.tags;
    if (Array.isArray(specTags)) {
      for (const tag of specTags) {
        if (isRecord(tag) && typeof tag.name === "string") {
          declared.push(tag.name);
        }
      }
    }
    const used = new Set<string>();
    for (const operation of operationsOf(spec)) {
      const tags = operation.operation.tags;
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) if (typeof tag === "string") used.add(tag);
    }
    expect([...used].sort()).toEqual([...new Set(declared)].sort());
  });

  test("contains no fabricated GS wire contract", () => {
    const spec = loadSpec();
    const raw = readText(SPEC_PATH);
    expect(Object.keys(specPaths(spec))).not.toContain(
      "/manager-tools/ajax.php",
    );
    expect(raw).not.toContain("manager-tools/ajax.php");

    // GSLive may be documented as an operator console, but never as a server or a path.
    const servers = JSON.stringify(spec.servers);
    expect(servers).not.toContain("sportswidgets.pro");
    expect(JSON.stringify(spec.paths)).not.toContain("sportswidgets.pro");
  });

  test("publishes the GSLive dual-surface deep links as documentation, not operations", () => {
    const spec = loadSpec();
    const info = spec.info;
    if (!isRecord(info)) throw new Error("spec.info must be an object");
    const description = info.description;
    expect(typeof description).toBe("string");
    expect(description).toContain("GSLive Manager (Partner 118)");
    expect(description).toContain("#/reports/users");
    expect(description).toContain("#/events/bet-history");
    expect(description).toContain("bot=true");
    expect(description).toContain("dateFilterBy=betTime");
    expect(description).toContain("./bin/dx gslive");

    const extension = spec["x-sportsdesk-gslive"];
    if (!isRecord(extension)) {
      throw new Error("spec must declare x-sportsdesk-gslive");
    }
    expect(extension.partnerId).toBe(118);
    expect(extension.origin).toBe("https://plive.sportswidgets.pro");
    expect(extension.kind).toBe("operator-deep-links-not-wire-operations");

    const surfaces = extension.surfaces;
    if (!Array.isArray(surfaces)) throw new Error("surfaces must be an array");
    expect(surfaces.map((surface) => isRecord(surface) && surface.id)).toEqual([
      "users-report",
      "bet-history-calctime",
      "bet-history-bettime",
    ]);
    for (const surface of surfaces) {
      if (!isRecord(surface)) continue;
      expect(String(surface.route)).toMatch(/^#\/(reports\/users|events\/bet-history)$/);
      expect(String(surface.example)).toContain(
        "https://plive.sportswidgets.pro/manager-tools/#/",
      );
    }

    // No GSLive operation may leak into paths.
    const operationPaths = operationsOf(spec).map((entry) => entry.path);
    expect(operationPaths.filter((entry) => entry.includes("manager-tools"))).toEqual([]);
  });

  test("getWebLog is tier A with a valid live x-capture response schema", () => {
    const spec = loadSpec();
    const operation = requireOperation(spec, /\/getWebLog$/i);
    expect(tierOf(operation)).toBe("A");

    const evidence = operation.operation["x-evidence"];
    if (!isRecord(evidence)) throw new Error("getWebLog is missing x-evidence");
    expect(evidence.capturedResponse).toBe(true);

    const responses = operation.operation.responses;
    if (!isRecord(responses)) throw new Error("getWebLog has no responses");
    const response200 = responses["200"];
    if (!isRecord(response200))
      throw new Error("getWebLog has no 200 response");
    expect(hasContent(response200)).toBe(true);

    const capture = operation.operation["x-capture"];
    if (!isRecord(capture)) throw new Error("getWebLog is missing x-capture");
    expect(String(capture.file)).toMatch(/\.post\.json$/);
    expect(String(capture.sha256)).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(capture.status)).toBeGreaterThanOrEqual(200);
    expect(Number(capture.status)).toBeLessThan(300);
    expect(Number(capture.samples)).toBeGreaterThanOrEqual(1);
  });

  test("tier C (inferred) operations carry no response content schema", () => {
    const operations = operationsOf(loadSpec());
    const inferred = operations.filter(
      (operation) => tierOf(operation) === "C",
    );
    expect(inferred.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const operation of inferred) {
      const responses = operation.operation.responses;
      if (!isRecord(responses)) continue;
      for (const [code, response] of Object.entries(responses)) {
        if (hasContent(response)) {
          offenders.push(`${operation.method} ${operation.path} ${code}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("auth schemes are declared and every security reference resolves", () => {
    const spec = loadSpec();
    const components = spec.components;
    const schemes =
      isRecord(components) && isRecord(components.securitySchemes)
        ? components.securitySchemes
        : undefined;
    if (schemes === undefined) {
      throw new Error("components.securitySchemes missing");
    }
    expect(Object.keys(schemes)).toContain("fantasy402Cookie");
    expect(Object.keys(schemes)).toContain("daemonBearer");

    const references = collectSecurityRefs(spec);
    expect(references.length).toBeGreaterThan(0);
    const dangling = references.filter(
      (reference) =>
        !Object.prototype.hasOwnProperty.call(schemes, reference.scheme),
    );
    expect(
      dangling.map(
        (reference) => `${reference.location} -> ${reference.scheme}`,
      ),
    ).toEqual([]);
  });
});

describe("required surfaces", () => {
  test("local daemon routes are documented", () => {
    const spec = loadSpec();
    const paths = Object.keys(specPaths(spec));
    for (const required of ["/health", "/api/watchlist"]) {
      expect(paths).toContain(required);
    }
    const telegramAlerts = findOperation(spec, /^\/api\/telegram\/alert$/);
    const telegramReports = findOperation(spec, /^\/api\/telegram\/report$/);
    expect(telegramAlerts?.method).toBe("post");
    expect(telegramReports?.method).toBe("post");
  });

  test("daemon UI surface is either documented or explicitly excluded", () => {
    const spec = loadSpec();
    const paths = Object.keys(specPaths(spec));
    const present = paths.includes("/miniapp") || paths.includes("/dashboard");
    if (present) {
      expect(present).toBe(true);
      return;
    }
    // Lead-approved fallback: an explicit evidence exclusion is acceptable.
    expect(existsSync(EVIDENCE_MD_PATH)).toBe(true);
    const evidence = readText(EVIDENCE_MD_PATH);
    expect(/miniapp|dashboard/i.test(evidence)).toBe(true);
  });

  test("Manager/getHistory is documented or explicitly excluded in EVIDENCE.md", () => {
    const spec = loadSpec();
    const documented = Object.keys(specPaths(spec)).some((path) =>
      /getHistory/i.test(path),
    );
    if (documented) {
      expect(documented).toBe(true);
      return;
    }
    expect(existsSync(EVIDENCE_MD_PATH)).toBe(true);
    const evidence = readText(EVIDENCE_MD_PATH);
    expect(/getHistory/i.test(evidence)).toBe(true);
    expect(
      /(exclud|not (?:in|documented)|missing|absent|out of scope)/i.test(
        evidence,
      ),
    ).toBe(true);
  });
});

describe("generated markdown + portal artifacts", () => {
  test("api-reference.md has no undefined renderer output and covers every path", () => {
    if (!existsSync(MARKDOWN_PATH)) {
      throw new Error("docs/api-reference.md missing");
    }
    const markdown = readText(MARKDOWN_PATH);
    expectNoIssues(checkMarkdownText(markdown));
    const paths = Object.keys(specPaths(loadSpec()));
    const missing = paths.filter((path) => !markdown.includes(path));
    expect(missing).toEqual([]);
    expect(markdown).toMatch(/evidence/i);
    expect(markdown).toMatch(/tier/i);
  });

  test("api-reference.md publishes the GSLive operator links with live example URLs", () => {
    if (!existsSync(MARKDOWN_PATH)) {
      throw new Error("docs/api-reference.md missing");
    }
    const markdown = readText(MARKDOWN_PATH);
    expect(markdown).toContain("## GSLive Manager (Partner 118): operator deep links");
    expect(markdown).toContain("#/reports/users");
    expect(markdown).toContain("dateFilterBy=calcTime");
    expect(markdown).toContain("dateFilterBy=betTime");
    expect(markdown).toContain("partnerUserId=CHURN_003");
    expect(markdown).toContain("./bin/dx gslive <LOGIN>");
    expect(markdown).not.toContain("the removed GS gateway");
  });

  test("index.html pins Scalar to a version with SRI and loads ./openapi.json", () => {
    if (!existsSync(INDEX_PATH)) throw new Error("docs/index.html missing");
    const html = readText(INDEX_PATH);
    expectNoIssues(checkIndexHtml(html));
    expect(html).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+/);
    expect(html).not.toMatch(/@latest/);
  });

  test("functions/_headers ships the required security headers", () => {
    if (!existsSync(HEADERS_PATH))
      throw new Error("functions/_headers missing");
    expectNoIssues(checkHeaders(readText(HEADERS_PATH)));
  });
});

describe("negative coverage — the gate bites", () => {
  test("rejects an operation with no x-evidence", () => {
    const mutated = structuredClone(loadSpec());
    const operations = operationsOf(mutated);
    const target = operations[0];
    if (target === undefined) {
      throw new Error("spec has no operations to mutate");
    }
    delete target.operation["x-evidence"];

    const outcome = checkOpenApi(mutated);
    expect(outcome.status).toBe("fail");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      CODES.EVIDENCE_MISSING,
    );
  });

  test("rejects a fabricated /manager-tools/ajax.php path", () => {
    const mutated = structuredClone(loadSpec());
    specPaths(mutated)["/manager-tools/ajax.php"] = { post: {} };

    const outcome = checkOpenApi(mutated);
    expect(outcome.status).toBe("fail");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      CODES.FORBIDDEN_PATH,
    );
  });

  test("rejects an invented getWebLog 200 response schema on a non-captured tier", () => {
    const mutated = structuredClone(loadSpec());
    const operation = requireOperation(mutated, /\/getWebLog$/i);
    const evidence = operation.operation["x-evidence"];
    if (!isRecord(evidence)) throw new Error("getWebLog is missing x-evidence");
    evidence.tier = "B";
    evidence.capturedResponse = false;
    delete operation.operation["x-capture"];
    const responses = operation.operation.responses;
    if (!isRecord(responses)) throw new Error("getWebLog has no responses");
    const response200 = responses["200"];
    if (!isRecord(response200)) {
      throw new Error("getWebLog has no 200 response");
    }
    response200.content = {
      "application/json": { schema: { type: "object" } },
    };

    const outcome = checkOpenApi(mutated);
    expect(outcome.status).toBe("fail");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      CODES.GETWEBLOG_RESPONSE_CONTENT,
    );
  });

  test("rejects invented response schemas on tier C operations", () => {
    const mutated = structuredClone(loadSpec());
    const operations = operationsOf(mutated);
    const target =
      operations.find((operation) => tierOf(operation) === "C") ??
      operations[0];
    if (target === undefined) {
      throw new Error("could not pick an operation to mutate");
    }
    const evidence = target.operation["x-evidence"];
    if (isRecord(evidence)) {
      evidence.tier = "C";
    } else {
      target.operation["x-evidence"] = {
        tier: "C",
        sources: ["none"],
        capturedResponse: false,
      };
    }
    if (!isRecord(target.operation.responses)) target.operation.responses = {};
    const responsesNow = target.operation.responses;
    if (!isRecord(responsesNow)) throw new Error("could not mutate responses");
    responsesNow["200"] = {
      description: "invented row object",
      content: { "application/json": { schema: { type: "object" } } },
    };

    const outcome = checkOpenApi(mutated);
    expect(outcome.status).toBe("fail");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      CODES.TIER_C_RESPONSE_CONTENT,
    );
  });

  test("rejects an unpinned Scalar CDN script without SRI", () => {
    const outcome = checkIndexHtml(
      '<script id="api-reference" data-url="./openapi.json" src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>',
    );
    expect(outcome.status).toBe("fail");
    const codes = outcome.issues.map((issue) => issue.code);
    expect(codes).toContain(CODES.SCALAR_UNPINNED);
    expect(codes).toContain(CODES.SCALAR_SRI);
  });

  test("rejects an index.html that forgets openapi.json", () => {
    const outcome = checkIndexHtml("<html><body>no spec here</body></html>");
    expect(outcome.status).toBe("fail");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      CODES.OPENAPI_REF,
    );
  });

  test("rejects _headers without the security directives", () => {
    const outcome = checkHeaders("/*\n  X-Frame-Options: DENY\n");
    expect(outcome.status).toBe("fail");
    const codes = outcome.issues.map((issue) => issue.code);
    expect(codes.filter((code) => code === CODES.HEADER_REQUIRED).length).toBe(
      4,
    );
  });

  test("rejects markdown containing undefined renderer output", () => {
    const markdown = `# reference\n\n${"x".repeat(2100)}\n\`undefined (undefined)\`\n`;
    const outcome = checkMarkdownText(markdown);
    expect(outcome.status).toBe("fail");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      CODES.MD_UNDEFINED,
    );
  });
});

/* ------------------------------------------------------------------------- */
/* getWebLog tier-A capture gate (P-E)                                        */
/* ------------------------------------------------------------------------- */

const VALID_TIER_A_CAPTURE = {
  file: "2026-10-31/getWebLog.post.json",
  sha256: "216affe5fe89706085b42b4093db302bdb0a6f7a218ffb8ab8d4dfc83b309202",
  capturedAt: "2026-10-31T12:34:56.000Z",
  status: 200,
  samples: 1,
} as const;

/** Upgrade getWebLog to a valid tier-A capture (x-evidence + x-capture + 200 schema). */
function makeTierAGetWebLog(): Record<string, unknown> {
  const mutated = structuredClone(loadSpec());
  const operation = requireOperation(mutated, /\/getWebLog$/i);
  operation.operation["x-evidence"] = {
    tier: "A",
    sources: [
      "capture:2026-10-31/getWebLog.post.json",
      `sha256:${VALID_TIER_A_CAPTURE.sha256}`,
    ],
    capturedResponse: true,
  };
  operation.operation["x-capture"] = { ...VALID_TIER_A_CAPTURE };
  const responses = operation.operation.responses;
  if (!isRecord(responses)) throw new Error("getWebLog has no responses");
  responses["200"] = {
    description:
      "Captured live 200 response; schema derived from the captured body skeleton.",
    content: {
      "application/json": {
        schema: { type: "array", items: { type: "object" } },
      },
    },
  };
  return mutated;
}

describe("getWebLog tier-A capture gate", () => {
  test("(a) tier B with 200 content still fails E_GETWEBLOG_RESPONSE_CONTENT", () => {
    const mutated = structuredClone(loadSpec());
    const operation = requireOperation(mutated, /\/getWebLog$/i);
    // Demote the now-captured getWebLog back to tier B (no capture) so the
    // tier-B fabrication rule is the one under test.
    const evidence = operation.operation["x-evidence"];
    if (!isRecord(evidence)) throw new Error("getWebLog is missing x-evidence");
    evidence.tier = "B";
    evidence.capturedResponse = false;
    delete operation.operation["x-capture"];
    const responses = operation.operation.responses;
    if (!isRecord(responses)) throw new Error("getWebLog has no responses");
    responses["200"] = {
      description: "invented",
      content: { "application/json": { schema: { type: "object" } } },
    };

    const outcome = checkOpenApi(mutated);
    const codes = outcome.issues.map((issue) => issue.code);
    expect(outcome.status).toBe("fail");
    expect(codes).toContain(CODES.GETWEBLOG_RESPONSE_CONTENT);
    // A claimed response below tier A is still fabrication, not a provenance bug.
    expect(codes).not.toContain(CODES.GETWEBLOG_TIER_A_CAPTURE_INVALID);
  });

  test("(b) tier A + valid x-capture with 200 content passes the gate", () => {
    const outcome = checkOpenApi(makeTierAGetWebLog());
    expect(outcome.issues).toEqual([]);
    expect(outcome.status).toBe("pass");
  });

  test("(c) tier A without x-capture fails E_GETWEBLOG_TIER_A_CAPTURE_INVALID", () => {
    const mutated = makeTierAGetWebLog();
    const operation = requireOperation(mutated, /\/getWebLog$/i);
    delete operation.operation["x-capture"];

    const outcome = checkOpenApi(mutated);
    const codes = outcome.issues.map((issue) => issue.code);
    expect(outcome.status).toBe("fail");
    expect(codes).toContain(CODES.GETWEBLOG_TIER_A_CAPTURE_INVALID);
    expect(codes).not.toContain(CODES.GETWEBLOG_RESPONSE_CONTENT);
  });

  test("(d) tier A with a non-hex sha256 fails E_GETWEBLOG_TIER_A_CAPTURE_INVALID", () => {
    const mutated = makeTierAGetWebLog();
    const operation = requireOperation(mutated, /\/getWebLog$/i);
    const capture = operation.operation["x-capture"];
    if (!isRecord(capture)) throw new Error("x-capture missing");
    capture.sha256 = "not-a-64-char-hex-digest";

    const outcome = checkOpenApi(mutated);
    const codes = outcome.issues.map((issue) => issue.code);
    expect(outcome.status).toBe("fail");
    expect(codes).toContain(CODES.GETWEBLOG_TIER_A_CAPTURE_INVALID);
    expect(codes).not.toContain(CODES.GETWEBLOG_RESPONSE_CONTENT);
  });

  test("(e) tier A content without capturedResponse=true still fails as non-A", () => {
    const mutated = makeTierAGetWebLog();
    const operation = requireOperation(mutated, /\/getWebLog$/i);
    const evidence = operation.operation["x-evidence"];
    if (!isRecord(evidence)) throw new Error("x-evidence missing");
    evidence.capturedResponse = false;

    const outcome = checkOpenApi(mutated);
    const codes = outcome.issues.map((issue) => issue.code);
    expect(codes).toContain(CODES.GETWEBLOG_RESPONSE_CONTENT);
  });
});
