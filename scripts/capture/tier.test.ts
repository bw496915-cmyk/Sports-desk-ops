import { describe, expect, test } from "bun:test";
import { deriveTier } from "./tier.ts";
import type { CaptureRecord } from "./types.ts";
import { CAPTURE_SCHEMA_VERSION } from "./types.ts";

function minimalRecord(
  provenance: CaptureRecord["provenance"],
  status = 500,
  bytes = 0,
): CaptureRecord {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    mode: "live",
    capturedAt: "2026-10-31T12:00:00.000Z",
    operation: { path: "/cloud/api/Report/getGrading", method: "POST" },
    request: {
      url: "https://example/cloud/api/Report/getGrading",
      method: "POST",
      headers: {},
      contentType: "application/json",
      bodySha256: "0".repeat(64),
      bodySkeleton: null,
    },
    response: {
      status,
      contentType: "text/plain",
      bodySha256: "1".repeat(64),
      bodySkeleton: { type: "null", nullable: true },
      bytes,
    },
    redaction: {
      policyVersion: 1,
      clean: true,
      fieldsRedacted: [],
      piiRedacted: [],
    },
    provenance,
    samples: 1,
  };
}

describe("deriveTier cloudflare edge", () => {
  test("empty-500 with cfRay reclassifies to C-edge", () => {
    const record = minimalRecord({
      portalHost: "www.fantasy402.com",
      proxy: "none",
      auth: "cookie",
      bunVersion: "1.4.4",
      body: "empty-500",
      waf: "cloudflare",
      cfRay: "a537f5fb4a4da5da-LAX",
      state: { challengePresent: true },
    });
    expect(deriveTier(record)).toBe("C-edge");
  });

  test("empty-500 without edge signal stays Tier C", () => {
    const record = minimalRecord({
      portalHost: "www.fantasy402.com",
      proxy: "none",
      auth: "cookie",
      bunVersion: "1.4.4",
      body: "empty-500",
    });
    expect(deriveTier(record)).toBe("C");
  });

  test("populated-shell derives A-shell (routing known, dynamic data unpopulated)", () => {
    const record = minimalRecord(
      {
        portalHost: "www.fantasy402.com",
        proxy: "none",
        auth: "cookie",
        bunVersion: "1.4.4",
        body: "populated-shell",
        request: "minimal",
        mutation: "read-inferred",
        state: {
          viewMode: "desktop",
          sessionStorageCleared: false,
          betTickerParam: false,
          domVersion: "1.0.280",
          domOrigin: "www.fantasy402.com",
        },
      },
      200,
      4096,
    );
    expect(deriveTier(record)).toBe("A-shell");
  });
});
