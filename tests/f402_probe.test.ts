import { describe, expect, test } from "bun:test";
import {
  PROBE_OPS,
  buildInstallRequestSnifferExpression,
  buildProbeBody,
  buildProbeExpression,
  buildReadRequestSnifferExpression,
  parseProbePageResult,
  parseSniffedTemplates,
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

  test("builds the client envelope from customer/report/report.js", () => {
    const pending = new URLSearchParams(
      buildProbeBody(PROBE_OPS[0]!, "agent-118", "cust-9"),
    );
    expect([...pending.keys()]).toEqual(["customerID", "token", "operation"]);
    expect(pending.get("customerID")).toBe("cust-9");
    // Security.token is empty in the browser session; the edge accepts the bearer instead.
    expect(pending.get("token")).toBe("");
    expect(pending.get("operation")).toBe("Pending");

    const tx = new URLSearchParams(
      buildProbeBody(
        PROBE_OPS.find((op) => op.operation === "getTransactions")!,
        "agent-118",
      ),
    );
    expect([...tx.keys()]).toEqual([
      "customerID",
      "date",
      "token",
      "operation",
    ]);
    expect(tx.get("customerID")).toBe("__CUSTOMER_ID__");
    expect(tx.get("date")).toBe("__DATE__");
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

describe("request sniffer", () => {
  test("installs XHR and fetch hooks scoped to /cloud/api/", () => {
    const expression = buildInstallRequestSnifferExpression();
    expect(expression).toContain("XMLHttpRequest.prototype");
    expect(expression).toContain("window.fetch");
    expect(expression).toContain("/cloud/api/");
    // Only parameter names are recorded, never values.
    expect(expression).toContain("formKeys");
  });

  test("reads back the sniffed array", () => {
    expect(buildReadRequestSnifferExpression()).toContain(
      "__f402SniffedRequests",
    );
  });

  test("parseSniffedTemplates dedupes by path, method and sorted keys", () => {
    const parsed = parseSniffedTemplates([
      {
        path: "/cloud/api/Manager/getInfoPlayer",
        method: "post",
        formKeys: ["agentID", "RRO"],
      },
      {
        path: "/cloud/api/Manager/getInfoPlayer",
        method: "POST",
        formKeys: ["RRO", "agentID"],
      },
      { path: "not-a-path", method: "POST", formKeys: [] },
      { path: "/cloud/api/Manager/x", method: "POST", formKeys: [1] },
    ]);
    expect(parsed).toEqual([
      {
        path: "/cloud/api/Manager/getInfoPlayer",
        method: "POST",
        formKeys: ["RRO", "agentID"],
      },
    ]);
  });
});
