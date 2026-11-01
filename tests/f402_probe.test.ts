import { describe, expect, test } from "bun:test";
import {
  MANAGER_BOOT_OPS,
  PROBE_OPS,
  buildInstallRequestSnifferExpression,
  buildJsonProbeBody,
  buildProbeExpression,
  buildProbeBody,
  buildReadRequestSnifferExpression,
  parseProbePageResult,
  parseSniffedTemplates,
  probeSummary,
  probeUrl,
  probeVerdict,
  selectProbeOps,
} from "../lib/f402_probe.ts";

describe("f402 probe plan", () => {
  test("excludes the unconfirmed mutation by default and selects manager-boot / all suites", () => {
    const ops = selectProbeOps(false);
    expect(ops.map((op) => op.operation)).not.toContain("PendingDelete");
    expect(ops).toHaveLength(PROBE_OPS.length - 4);
    expect(selectProbeOps(true)).toHaveLength(PROBE_OPS.length);

    const bootOps = selectProbeOps(false, "manager-boot");
    expect(bootOps).toHaveLength(9);
    expect(bootOps.map((op) => op.operation)).toEqual([
      "getAccountInfoOwner",
      "getConfigWebReports",
      "getConfigWebReportsPending",
      "getSportsType",
      "getAuthorizations",
      "getMessage",
      "getNewEmailsCount",
      "getWeeklyFigureByAgentLite",
      "getListAgenstByAgent",
    ]);

    const allReadOnly = selectProbeOps(false, "all");
    // 7 read-only report ops + 8 unique manager-boot ops (getListAgenstByAgent is shared) = 15
    expect(allReadOnly).toHaveLength(18);
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

  test("builds the client envelope from customer/report/report.js and app/manager/manager.js", () => {
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

    // PendingDelete sends sentinel ticketNumber=-1 by default
    const pendingDelete = new URLSearchParams(
      buildProbeBody(
        PROBE_OPS.find((op) => op.operation === "PendingDelete")!,
        "agent-118",
      ),
    );
    expect(pendingDelete.get("ticketNumber")).toBe("-1");

    // JSON wire bodies for getAccountInfoOwner (manager.js:31200) & getDailyFiguresByCustomer (report.js:25633)
    const acctOwnerOp = MANAGER_BOOT_OPS.find(
      (op) => op.operation === "getAccountInfoOwner",
    )!;
    expect(acctOwnerOp.wireContentType).toBe("application/json");
    expect(JSON.parse(buildJsonProbeBody(acctOwnerOp, "MILLER500"))).toEqual({
      agentID: "MILLER500",
      operation: "getAccountInfoOwner",
      agentOwner: "MILLER500",
    });

    const dailyFigOp = PROBE_OPS.find(
      (op) => op.operation === "getDailyFiguresByCustomer",
    )!;
    expect(dailyFigOp.wireContentType).toBe("application/json");
    expect(
      JSON.parse(buildJsonProbeBody(dailyFigOp, "MILLER500", "H1716")),
    ).toEqual({
      agentID: "MILLER500",
      customerID: "H1716",
      week: "__WEEK__",
      operation: "getDailyFiguresByCustomer",
    });
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

describe("probe expression", () => {
  test("resolves markers in-page and sends the bearer", () => {
    const expression = buildProbeExpression({
      operation: "getTransactions",
      url: "https://fantasy402.com/cloud/api/Report/getTransactions",
      body: "customerID=__CUSTOMER_ID__&date=__DATE__&token=&operation=getTransactions",
    });
    expect(expression).toContain('replaceAll("__CUSTOMER_ID__"');
    expect(expression).toContain('replaceAll("__DATE__"');
    expect(expression).toContain('authorization = "Bearer " + token');
    expect(expression).toContain("sessionStorage.getItem");
    // The markers are plain text so URL encoding cannot turn them into %7B…%7D.
    expect(expression).not.toContain("%7B");
  });

  test("supports contentType: application/json without URL-encoding JSON string values", () => {
    const expression = buildProbeExpression({
      operation: "getAccountInfoOwner",
      url: "https://fantasy402.com/cloud/api/Manager/getAccountInfoOwner",
      body: '{"agentID":"MILLER500","operation":"getAccountInfoOwner"}',
      contentType: "application/json",
    });
    expect(expression).toContain('"content-type": "application/json"');
    expect(expression).toContain('.replaceAll("__CUSTOMER_ID__", customerID)');
  });

  test("a supplied week value overrides the default week index", () => {
    const expression = buildProbeExpression(
      {
        operation: "getDailyFiguresByCustomer",
        url: "https://fantasy402.com/cloud/api/Report/getDailyFiguresByCustomer",
        body: "agentID=1&customerID=__CUSTOMER_ID__&week=__WEEK__&token=&operation=getDailyFiguresByCustomer",
      },
      2_000,
      "3",
    );
    // The override is carried into the page as a JSON string (never interpolated raw).
    expect(expression).toContain('const weekOverride = "3";');
    expect(expression).toContain(
      'replaceAll("__WEEK__", encodeURIComponent(weekValueResolved))',
    );
    // The default (yesterday's date) is still computed for the __DATE__ marker.
    expect(expression).toContain("const mdy =");
  });

  test("an empty week value keeps the default '0' index", () => {
    const expression = buildProbeExpression(
      {
        operation: "getDailyFiguresByCustomer",
        url: "https://fantasy402.com/cloud/api/Report/getDailyFiguresByCustomer",
        body: "week=__WEEK__&token=&operation=getDailyFiguresByCustomer",
      },
      2_000,
      undefined,
    );
    expect(expression).toContain('const weekOverride = "";');
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
