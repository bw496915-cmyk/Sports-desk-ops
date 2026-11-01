import { describe, expect, test } from "bun:test";
import {
  PROBE_OPS,
  buildProbeBody,
  buildProbeExpression,
  parseProbePageResult,
  probeSummary,
  probeUrl,
  probeVerdict,
  selectProbeOps,
} from "../lib/f402_probe.ts";

describe("f402 probe plan", () => {
  test("excludes the unconfirmed mutation by default", () => {
    const ops = selectProbeOps(false);
    expect(ops.map((op) => op.operation)).not.toContain("PendingDelete");
    expect(ops).toHaveLength(PROBE_OPS.length - 1);
    expect(selectProbeOps(true)).toHaveLength(PROBE_OPS.length);
  });

  test("builds URLs from the observed route prefix", () => {
    const op = PROBE_OPS[0]!;
    expect(probeUrl("https://fantasy402.com", op)).toBe(
      "https://fantasy402.com/cloud/api/Manager/Pending",
    );
    expect(probeUrl("https://fantasy402.com", op, "/cloud/api/Report")).toBe(
      "https://fantasy402.com/cloud/api/Report/Pending",
    );
    expect(probeUrl("https://fantasy402.com/base/", op)).toBe(
      "https://fantasy402.com/base/cloud/api/Manager/Pending",
    );
    expect(() => probeUrl("file:///tmp/x", op)).toThrow("http(s)");
    expect(() => probeUrl("https://fantasy402.com", op, "cloud")).toThrow(
      "start with /",
    );
  });

  test("builds the observed form envelope without leaking values", () => {
    const body = buildProbeBody(PROBE_OPS[0]!, "agent-118", "cust-9");
    const params = new URLSearchParams(body);
    expect(params.get("operation")).toBe("Pending");
    expect(params.get("RRO")).toBe("1");
    expect(params.get("agentID")).toBe("agent-118");
    expect(params.get("agentOwner")).toBe("agent-118");
    expect(params.get("customerID")).toBe("cust-9");
    expect(buildProbeBody(PROBE_OPS[0]!, "agent-118")).not.toContain(
      "customerID",
    );
  });

  test("the expression carries credentials and cannot be broken by quotes", () => {
    const expression = buildProbeExpression({
      operation: "Pending",
      url: "https://www.fantasy402.com/api/Report/Pending",
      body: `partner=118&note="x"'\n&next=1`,
    });
    expect(expression).toContain('credentials: "include"');
    expect(expression).toContain("x-requested-with");
    expect(expression).toContain(
      "https://www.fantasy402.com/api/Report/Pending",
    );
    // JSON.stringify keeps the newline inside the literal rather than ending the statement.
    expect(expression).toContain("\\n");
    expect(expression.startsWith("(async () => {")).toBe(true);
  });

  test("validates the page result before it is treated as evidence", () => {
    const ok = {
      status: 200,
      contentType: "application/json",
      bytes: 12,
      preview: "{}",
    };
    expect(parseProbePageResult(ok)).toEqual(ok);
    expect(() => parseProbePageResult(null)).toThrow("no object");
    expect(() => parseProbePageResult({ ...ok, status: 0 })).toThrow("status");
    expect(() => parseProbePageResult({ ...ok, bytes: -1 })).toThrow(
      "byte count",
    );
    expect(() => parseProbePageResult({ ...ok, preview: 1 })).toThrow(
      "preview",
    );
  });

  test("classifies statuses with the same vocabulary the plan uses", () => {
    expect(probeVerdict(200)).toBe("exists");
    expect(probeVerdict(401)).toBe("denied");
    expect(probeVerdict(403)).toBe("denied");
    expect(probeVerdict(404)).toBe("missing");
    expect(probeVerdict(405)).toBe("missing");
    expect(probeVerdict(500)).toBe("error");
    expect(
      probeSummary(PROBE_OPS[0]!, {
        status: 404,
        contentType: "text/html",
        bytes: 0,
        preview: "",
      }),
    ).toEqual({
      operation: "Pending",
      verdict: "missing",
      status: 404,
      bytes: 0,
    });
  });
});
