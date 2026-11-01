import { describe, expect, test } from "bun:test";
import {
  captureRecipeFingerprint,
  cfRayFromResponseHeaders,
  classifyHtmlBodyVerdict,
  isCaptureEdgePath,
  isChallengeBoundCapture,
  isJsonEmptyEnvelope,
  provenanceFromWireFetch,
  verifyProvenanceConsistency,
} from "./provenance_helpers.ts";

describe("provenance_helpers", () => {
  test("isCaptureEdgePath flags /cdn-cgi/", () => {
    expect(
      isCaptureEdgePath("/cdn-cgi/challenge-platform/scripts/jsd/main.js"),
    ).toBe(true);
    expect(isCaptureEdgePath("/cloud/api/Report/Pending")).toBe(false);
  });

  test("cfRayFromResponseHeaders reads Cf-Ray", () => {
    const headers = new Headers({ "cf-ray": "a537f5fb4a4da5da-LAX" });
    expect(cfRayFromResponseHeaders(headers)).toBe("a537f5fb4a4da5da-LAX");
  });

  test("provenanceFromWireFetch marks cloudflare from cf-ray header or responseHeaders", () => {
    const prov = provenanceFromWireFetch(
      {
        portalHost: "www.fantasy402.com",
        bunVersion: "1.4.4",
        headersObserved: true,
      },
      {
        status: 500,
        bytes: 0,
        preview: "",
        responseHeaders: { "cf-ray": "abc123-SJC" },
      },
    );
    expect(prov.waf).toBe("cloudflare");
    expect(prov.cfRay).toBe("abc123-SJC");
    expect(prov.body).toBe("empty-500");
  });

  test("captureRecipeFingerprint for challenge-bound 2xx", () => {
    const prov = provenanceFromWireFetch(
      { portalHost: "x", bunVersion: "1.4.4", backend: "chrome" },
      {
        status: 200,
        bytes: 100,
        preview: '{"LIST":[]}',
        cfRay: "ray-1",
      },
    );
    expect(prov.body).toBe("empty-envelope");
    expect(isChallengeBoundCapture(prov)).toBe(true);
    expect(captureRecipeFingerprint(prov)?.length).toBe(64);
  });

  test("Fix 1: empty game template (data-component='game' with empty data-field spans) is classified as populated-shell, not populated", () => {
    const emptyGameTemplate = `
      <div class="content-page-out"></div>
      <div data-component="game">
        <span data-field="team-1"></span>
        <span data-field="team-2"></span>
      </div>
      <span data-field="version">1.0.280</span>
      <span data-field="domain-me">www.fantasy402.com</span>
    `;
    expect(
      classifyHtmlBodyVerdict(emptyGameTemplate, {
        domVersion: "1.0.280",
        domOrigin: "www.fantasy402.com",
      }),
    ).toBe("populated-shell");

    const populatedGameHtml = `
      <div data-component="game">
        <span data-field="team-1">Los Angeles Lakers</span>
        <span data-field="team-2">Boston Celtics</span>
      </div>
    `;
    expect(classifyHtmlBodyVerdict(populatedGameHtml)).toBe("populated");
  });

  test("Fix 2: request and mutation overrides thread through ProbeCaptureProvenanceInput", () => {
    const exactJson = provenanceFromWireFetch(
      {
        portalHost: "www.fantasy402.com",
        bunVersion: "1.4.4",
        viewMode: "desktop",
        request: "exact",
        mutation: "read",
      },
      {
        status: 200,
        contentType: "application/json",
        bytes: 4096,
        preview: '{"FIGURES":[{"week":0}]}',
        domVersion: "1.0.280",
        domOrigin: "www.fantasy402.com",
      },
    );
    expect(exactJson.body).toBe("populated");
    expect(exactJson.request).toBe("exact");
    expect(exactJson.mutation).toBe("read");
    expect(exactJson.origin).toBe("www.fantasy402.com");
    expect(exactJson.state?.domVersion).toBe("1.0.280");
    expect(exactJson.state?.domOrigin).toBe("www.fantasy402.com");

    const sentinelProbe = provenanceFromWireFetch(
      {
        portalHost: "www.fantasy402.com",
        bunVersion: "1.4.4",
        request: "sentinel",
        mutation: "read-inferred",
      },
      {
        status: 200,
        contentType: "application/json",
        bytes: 14,
        preview: '{"Pending":[]}',
      },
    );
    expect(sentinelProbe.request).toBe("sentinel");
    expect(sentinelProbe.body).toBe("empty-envelope");
    expect(isJsonEmptyEnvelope('{"Pending":[]}')).toBe(true);
  });

  test("verifyProvenanceConsistency checks domOrigin vs portalHost, domVersion vs expectedVersion, and waf vs cfRay", () => {
    const wafNoRay = verifyProvenanceConsistency({
      portalHost: "www.fantasy402.com",
      proxy: "none",
      auth: "cookie",
      bunVersion: "1.4.4",
      waf: "cloudflare",
    });
    expect(wafNoRay.ok).toBe(false);
    expect(wafNoRay.wafRayMismatch).toBe(true);
    expect(wafNoRay.issues).toContain(
      'waf is "cloudflare" but no cfRay captured',
    );

    const rayUnknownWaf = verifyProvenanceConsistency({
      portalHost: "www.fantasy402.com",
      proxy: "none",
      auth: "cookie",
      bunVersion: "1.4.4",
      waf: "unknown",
      cfRay: "a537f5fb4a4da5da-LAX",
    });
    expect(rayUnknownWaf.ok).toBe(false);
    expect(rayUnknownWaf.wafRayMismatch).toBe(true);
    expect(rayUnknownWaf.issues).toContain(
      'cfRay "a537f5fb4a4da5da-LAX" present but waf is "unknown"',
    );
  });

  test("captureRecordFromProbeScratch preserves valid array skeleton for truncated top-level JSON arrays (getSportsCustomerAdmin)", async () => {
    const { captureRecordFromProbeScratch } =
      await import("./promote_probe_from_file.ts");
    const record = captureRecordFromProbeScratch({
      url: "https://www.fantasy402.com/cloud/api/Manager/getSportsCustomerAdmin",
      capturedAt: "2026-11-01T04:48:42.301Z",
      backend: "webkit",
      requestContentType: "application/x-www-form-urlencoded; charset=UTF-8",
      body: "operation=getSportsCustomerAdmin&RRO=1&agentID=BILLY666&agentOwner=BILLY666",
      readOnlyConfirmed: true,
      headersObserved: true,
      result: {
        status: 200,
        contentType: "application/json; charset=utf-8",
        bytes: 14072,
        preview:
          '[{"SportType":"Auto Racing         ","SequenceNumber":"12001"},{"SportType":"Virtual Sports      ","SequenceNumber":"18001"}',
        cfRay: "a53844c7c9d46d3d-ATL",
        cfRayFromHeader: "a53844c7c9d46d3d-ATL",
        isBinary: false,
      },
    });
    expect(record.response?.bodySkeleton.truncated).toBe(true);
    expect(record.response?.bytes).toBe(14072);
    expect(record.response?.bodySkeleton.type).toBe("array");
  });
});
