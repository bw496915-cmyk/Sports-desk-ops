import { describe, expect, test } from "bun:test";
import { buildCaptureRecord } from "../scripts/capture/recorder.ts";
import { deriveTier, deriveTierWithReason } from "../scripts/capture/tier.ts";
import type {
  CaptureProvenance,
  CaptureRecord,
} from "../scripts/capture/types.ts";

const BASE_PROVENANCE: CaptureProvenance = {
  portalHost: "fantasy402.com",
  proxy: "none",
  auth: "cookie",
  bunVersion: "1.4.4",
};

function recordWith(
  provenance: CaptureProvenance,
  responseBytes: Uint8Array = new TextEncoder().encode("{}"),
): CaptureRecord {
  return buildCaptureRecord({
    mode: "live",
    capturedAt: "2026-11-01T02:07:38.875Z",
    operation: { path: "/cloud/api/Report/Pending", method: "POST" },
    request: {
      url: "https://fantasy402.com/cloud/api/Report/Pending",
      method: "POST",
      headers: {},
      contentType: "application/json",
      body: "{}",
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      contentType: "application/json",
      bytes: responseBytes,
    },
    provenance,
  });
}

describe("deriveTier and deriveTierWithReason", () => {
  test("a populated, sufficiently specific read is tier A with explicit reason", () => {
    const record = recordWith({
      ...BASE_PROVENANCE,
      body: "populated",
      request: "exact",
      mutation: "read",
    });
    expect(deriveTier(record)).toBe("A");
    expect(deriveTierWithReason(record)).toEqual({
      tier: "A",
      reason: "body is populated with exact request and read mutation",
    });
  });

  test("a populated read with a known mutation and minimal specificity is tier A", () => {
    const record = recordWith({
      ...BASE_PROVENANCE,
      body: "populated",
      request: "minimal",
      mutation: "read-inferred",
    });
    expect(deriveTier(record)).toBe("A");
  });

  test("a populated read without a known mutation or with a sentinel/synthetic/mismatched request is tier C with distinct reasons", () => {
    const sentinel = recordWith({
      ...BASE_PROVENANCE,
      body: "populated",
      request: "sentinel",
      mutation: "read-inferred",
    });
    expect(deriveTier(sentinel)).toBe("C");
    expect(deriveTierWithReason(sentinel).reason).toContain(
      "request is sentinel",
    );

    const mismatched = recordWith({
      ...BASE_PROVENANCE,
      body: "populated",
      request: "mismatched",
      mutation: "read-inferred",
    });
    expect(deriveTierWithReason(mismatched)).toEqual({
      tier: "C",
      reason:
        "body is populated but request is mismatched (requires exact or minimal)",
    });

    const unknownMutation = recordWith({
      ...BASE_PROVENANCE,
      body: "populated",
      request: "exact",
      mutation: "unknown",
    });
    expect(deriveTier(unknownMutation)).toBe("C");
    expect(deriveTierWithReason(unknownMutation)).toEqual({
      tier: "C",
      reason: "body is populated but mutation is unknown",
    });
  });

  test("a populated shell (server-rendered chrome, data not evidenced) is tier A-shell", () => {
    const record = recordWith({ ...BASE_PROVENANCE, body: "populated-shell" });
    expect(deriveTier(record)).toBe("A-shell");
    expect(deriveTierWithReason(record).reason).toContain("populated-shell");
  });

  test("an empty envelope is promoted but flagged A-empty", () => {
    const record = recordWith({ ...BASE_PROVENANCE, body: "empty-envelope" });
    expect(deriveTier(record)).toBe("A-empty");
    expect(deriveTierWithReason(record).reason).toContain("empty-envelope");
  });

  test("a template is tier A-shell (routing only, not data)", () => {
    const record = recordWith({ ...BASE_PROVENANCE, body: "template" });
    expect(deriveTier(record)).toBe("A-shell");
    expect(deriveTierWithReason(record).reason).toContain("template");
  });

  test("an error body rejected by a write mutation is tier D", () => {
    const record = buildCaptureRecord({
      mode: "live",
      capturedAt: "2026-11-01T02:07:38.875Z",
      operation: { path: "/cloud/api/Manager/getBetTicker", method: "POST" },
      request: {
        url: "https://fantasy402.com/cloud/api/Manager/getBetTicker",
        method: "POST",
        headers: {},
        contentType: "application/json",
        body: "{}",
      },
      response: {
        status: 400,
        headers: { "content-type": "application/json" },
        contentType: "application/json",
        bytes: new TextEncoder().encode("{}"),
      },
      provenance: {
        ...BASE_PROVENANCE,
        body: "error-body",
        mutation: "write",
      },
    });
    expect(deriveTier(record)).toBe("D");
    expect(deriveTierWithReason(record).reason).toContain(
      "write mutation rejected with HTTP 400",
    );
  });

  test("an error body without a rejected write is tier C with error-body reason", () => {
    const record = recordWith({ ...BASE_PROVENANCE, body: "error-body" });
    expect(deriveTier(record)).toBe("C");
    expect(deriveTierWithReason(record).reason).toContain("error-body");
  });

  test("an empty 5xx and a missing body are tier C with distinct reasons", () => {
    const empty500 = recordWith({ ...BASE_PROVENANCE, body: "empty-500" });
    expect(deriveTier(empty500)).toBe("C");
    expect(deriveTierWithReason(empty500).reason).toContain(
      "empty-500 with no edge signal",
    );

    const none = recordWith({ ...BASE_PROVENANCE, body: "none" });
    expect(deriveTier(none)).toBe("C");
    expect(deriveTierWithReason(none).reason).toContain("body is none");
  });

  test("a missing body verdict defaults through normalization to tier C", () => {
    const record = recordWith({ ...BASE_PROVENANCE });
    expect(record.provenance.body).toBe("none");
    expect(deriveTier(record)).toBe("C");
  });

  test("contradicted observations of one operation are tier B", () => {
    const record = recordWith({ ...BASE_PROVENANCE, body: "populated" });
    expect(deriveTier(record, { contradicted: true })).toBe("B");
    expect(
      deriveTierWithReason(record, { contradicted: true }).reason,
    ).toContain("contradicting results");
  });

  test("retired operations are tier E", () => {
    const record = recordWith({ ...BASE_PROVENANCE, body: "populated" });
    expect(deriveTier(record, { retired: true })).toBe("E");
    expect(deriveTierWithReason(record, { retired: true }).reason).toContain(
      "retired",
    );
  });
});
