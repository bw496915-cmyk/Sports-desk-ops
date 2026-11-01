import { describe, expect, test } from "bun:test";

import {
  buildApiPrefixMatrixExpression,
  F402_API_PREFIXES,
  F402_WIRE_ACCEPT,
  inPageCloudApiHeadersJs,
  inPageCollectResponseHeadersJs,
  redactedInPageRequestHeaders,
  redactedRequestHeaderProtocolVariants,
} from "./f402_in_page_fetch.ts";
import { buildBatchPendingDeleteExpression } from "./f402_pending_delete_batch.ts";
import { buildProbeExpression } from "./f402_probe.ts";

describe("f402 in-page fetch headers", () => {
  test("wire accept is */* (Chrome DevTools Manager XHR)", () => {
    expect(F402_WIRE_ACCEPT).toBe("*/*");
    const single = buildProbeExpression({
      operation: "getDeletedTransactionHistory",
      url: "https://www.fantasy402.com/cloud/api/Manager/getDeletedTransactionHistory",
      body: "operation=getDeletedTransactionHistory",
    });
    expect(single).toContain('accept: "*/*"');
  });

  test("HTTP/2 and HTTP/1.1 redacted request variants share accept/cookie", () => {
    const v = redactedRequestHeaderProtocolVariants({
      baseUrl: "https://www.fantasy402.com",
      path: "/cloud/api/Manager/getDeletedTransactionHistory",
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      tokenPresent: true,
    });
    expect(v.http2[":authority"]).toBe("www.fantasy402.com");
    expect(v.http2[":path"]).toBe(
      "/cloud/api/Manager/getDeletedTransactionHistory",
    );
    expect(v.http1.host).toBe("www.fantasy402.com");
    expect(v.http1["request-target"]).toContain("POST /cloud/api/Manager/");
    expect(v.http2.accept).toBe("*/*");
    expect(v.http1.cookie).toBe("<redacted>");
  });

  test("single probe and batch expressions share XHR headers", () => {
    const batch = buildBatchPendingDeleteExpression(
      "https://fantasy402.com/cloud/api/Report/PendingDelete",
      [{ ticketNumber: "1", body: "x=1" }],
    );
    for (const expr of [batch, inPageCloudApiHeadersJs("text/plain")]) {
      expect(expr).toContain("*/*");
      expect(expr).toContain("XMLHttpRequest");
    }
  });

  test("response header collector includes cf-cache-status", () => {
    expect(inPageCollectResponseHeadersJs(false)).toContain("cf-cache-status");
  });

  test("prefix matrix expression sweeps Manager Report System", () => {
    const expr = buildApiPrefixMatrixExpression("https://www.fantasy402.com", [
      {
        prefix: F402_API_PREFIXES[0]!,
        operation: "getDeletedTransactionHistory",
        body: "x=1",
      },
    ]);
    expect(expr).toContain("/cloud/api/Manager");
    expect(expr).toContain("for (const row of matrix)");
  });

  test("explicit redacted headers omit browser-only fields", () => {
    expect(redactedInPageRequestHeaders("application/x-test", true)).toEqual({
      accept: "*/*",
      "content-type": "application/x-test",
      "x-requested-with": "XMLHttpRequest",
      authorization: "Bearer <redacted>",
    });
  });
});
