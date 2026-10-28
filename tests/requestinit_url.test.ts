import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * WHATWG Fetch & URL Standard rules for Request URL normalization:
 * - Scheme & Host: Case-insensitive ASCII, normalized to lowercase.
 * - Path & Query: Case-sensitive, exact case preserved.
 * - Default ports: Port 80 for HTTP and 443 for HTTPS are stripped from request.url.
 * - IPv6 addresses: Bracketed format [::1] is preserved.
 * - Relative URLs: In Bun (server-side runtime), there is no base document URL.
 *   `new Request("/api")` throws TypeError: Invalid URL.
 * - URL Credentials in Bun: Bun automatically converts credentials in the URL
 *   (e.g., https://user:pass@host/) into an `Authorization: Basic ...` header
 *   unless an explicit `Authorization` header is provided.
 */

describe("RequestInit URL normalization, credentials and base URL constraints", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let lastCapturedAuthHeader: string | null = null;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        lastCapturedAuthHeader = req.headers.get("authorization");
        return new Response("ok", { status: 200 });
      },
    });
    baseUrl = `127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("scheme and host are normalized to lowercase", () => {
    const req = new Request("HTTP://EXAMPLE.COM/test");
    expect(req.url).toBe("http://example.com/test");
  });

  test("path and query casing are strictly preserved", () => {
    const req = new Request("http://example.com/API/V1/Users?FilterStatus=ACTIVE&UserId=MM800");
    expect(req.url).toBe("http://example.com/API/V1/Users?FilterStatus=ACTIVE&UserId=MM800");
  });

  test("default ports are stripped from request.url (HTTP 80, HTTPS 443)", () => {
    const reqHttp = new Request("http://example.com:80/resource");
    expect(reqHttp.url).toBe("http://example.com/resource");

    const reqHttps = new Request("https://example.com:443/resource");
    expect(reqHttps.url).toBe("https://example.com/resource");
  });

  test("non-default ports are retained in request.url", () => {
    const req = new Request("http://example.com:8080/resource");
    expect(req.url).toBe("http://example.com:8080/resource");
  });

  test("IPv6 addresses are properly bracketed", () => {
    const req = new Request("http://[::1]:3000/api");
    expect(req.url).toBe("http://[::1]:3000/api");
  });

  test("relative URL without base throws TypeError in server-side Bun", () => {
    expect(() => {
      new Request("/api/v1/resource");
    }).toThrow(TypeError);
  });

  test("URL credentials convert to Basic Authorization header in Bun", async () => {
    lastCapturedAuthHeader = null;
    const urlWithCreds = `http://adminUser:secretPass@${baseUrl}/protected`;
    await fetch(urlWithCreds);

    expect(lastCapturedAuthHeader).not.toBeNull();
    // adminUser:secretPass in Base64 is YWRtaW5Vc2VyOnNlY3JldFBhc3M=
    const expectedBase64 = Buffer.from("adminUser:secretPass").toString("base64");
    expect(lastCapturedAuthHeader).toBe(`Basic ${expectedBase64}`);
  });

  test("explicit Authorization header overrides URL credentials", async () => {
    lastCapturedAuthHeader = null;
    const urlWithCreds = `http://adminUser:secretPass@${baseUrl}/protected`;
    await fetch(urlWithCreds, {
      headers: {
        Authorization: "Bearer override-token-123",
      },
    });

    expect(lastCapturedAuthHeader).toBe("Bearer override-token-123");
  });
});
