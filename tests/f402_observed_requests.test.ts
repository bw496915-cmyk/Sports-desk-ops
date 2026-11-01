import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ANALYSIS_REPORTS } from "../lib/analysis_filters.ts";

/**
 * Two live manager requests an operator pasted on 2026-11-01, recorded as *request* shapes only.
 *
 * This exists because both operations were previously unrecorded in this repo: getSubSportByReport
 * appeared nowhere, and getAgentPerformance was only an inferred URL with no request. Neither
 * response was observed, so nothing here may describe one.
 */
const fixture = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dir,
      "fixtures/f402-report-requests-observed-2026-11-01.json",
    ),
    "utf8",
  ),
) as {
  observedAt: string;
  responsesObserved: boolean;
  agentPlaceholder: string;
  requests: Array<{
    operation: string;
    pathObserved: string | null;
    pathStatus: string;
    contentType: string;
    fields: Record<string, string>;
  }>;
};

const byOperation = (name: string) => {
  const request = fixture.requests.find((entry) => entry.operation === name);
  if (request === undefined) throw new Error(`fixture has no ${name}`);
  return request;
};

describe("observed manager requests (2026-11-01)", () => {
  test("records requests only, never a response", () => {
    expect(fixture.responsesObserved).toBe(false);
    for (const request of fixture.requests) {
      expect(Object.keys(request)).not.toContain("response");
    }
  });

  test("stores no credential material", () => {
    const raw = JSON.stringify(fixture);
    for (const forbidden of [
      "eyJ", // JWT prefix
      "Bearer",
      "cf_clearance",
      "__cf_bm",
      "authorization",
      "password",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    // Identifiers are placeholders, not the pasted logins.
    for (const request of fixture.requests) {
      expect(request.fields.agentID).toBe(fixture.agentPlaceholder);
      expect(request.fields.agentOwner).toBe(fixture.agentPlaceholder);
    }
  });

  test("getSubSportByReport has an observed Manager path", () => {
    const request = byOperation("getSubSportByReport");
    expect(request.pathObserved).toBe("/cloud/api/Manager/getSubSportByReport");
    expect(request.pathStatus).toBe("observed");
    expect(Object.keys(request.fields)).toEqual([
      "customerID",
      "sport",
      "operation",
      "RRO",
      "agentID",
      "agentOwner",
    ]);
  });

  test("getAgentPerformance has a body but no URL", () => {
    // The paste lost the URL, so the ledger's inferred Report/ path stays a claim, not a fact.
    const request = byOperation("getAgentPerformance");
    expect(request.pathObserved).toBeNull();
    expect(request.pathStatus).toContain("without its URL");
    expect(Object.keys(request.fields)).toEqual([
      "start",
      "end",
      "agentID",
      "type",
      "freePlay",
      "store",
      "sport",
      "subsport",
      "period",
      "wagerType",
      "betType",
      "tipo",
      "debug",
      "operation",
      "RRO",
      "agentOwner",
    ]);
  });

  test("type=CP is a real wire value, matching the Analysis filter vocabulary", () => {
    const cp = ANALYSIS_REPORTS.find((entry) => entry.value === "CP");
    expect(cp).toBeDefined();
    expect(byOperation("getAgentPerformance").fields.type).toBe(cp?.value);
  });

  test("sport is padded to 20 characters on the wire", () => {
    // "Football" + 12 spaces. Trimming it is correct for parsing and wrong for a replay, so the
    // padding is pinned rather than normalised away.
    for (const request of fixture.requests) {
      const sport = request.fields.sport ?? "";
      expect(sport.trim()).toBe("Football");
      expect(sport).toHaveLength(20);
      expect(sport).toBe("Football".padEnd(20, " "));
    }
  });

  test("empty filters are sent as empty strings, not omitted", () => {
    // A replay that drops subsport/wagerType/betType is not the request the portal sends.
    const fields = byOperation("getAgentPerformance").fields;
    for (const key of ["subsport", "wagerType", "betType"]) {
      expect(Object.keys(fields)).toContain(key);
      expect(fields[key]).toBe("");
    }
  });

  test("dates are M/D/YYYY in start and end", () => {
    const fields = byOperation("getAgentPerformance").fields;
    expect(fields.start).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
    expect(fields.end).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  test("both requests are form-encoded", () => {
    for (const request of fixture.requests) {
      expect(request.contentType).toStartWith(
        "application/x-www-form-urlencoded",
      );
    }
  });
});
