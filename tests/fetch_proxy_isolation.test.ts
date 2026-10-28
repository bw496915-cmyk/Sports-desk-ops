import { afterEach, beforeEach, describe, expect, test } from "bun:test";

describe("Outbound Fetch Proxy Isolation (NO_PROXY Verification)", () => {
  let server: ReturnType<typeof Bun.serve>;
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalAllProxy = process.env.ALL_PROXY;
  const originalNoProxy = process.env.NO_PROXY;

  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        return Response.json({
          status: "isolated",
          pathname: url.pathname,
          clientIP: "127.0.0.1",
        });
      },
    });
  });

  afterEach(() => {
    server.stop(true);
    if (originalHttpProxy !== undefined) {
      process.env.HTTP_PROXY = originalHttpProxy;
    } else {
      delete process.env.HTTP_PROXY;
    }
    if (originalHttpsProxy !== undefined) {
      process.env.HTTPS_PROXY = originalHttpsProxy;
    } else {
      delete process.env.HTTPS_PROXY;
    }
    if (originalAllProxy !== undefined) {
      process.env.ALL_PROXY = originalAllProxy;
    } else {
      delete process.env.ALL_PROXY;
    }
    if (originalNoProxy !== undefined) {
      process.env.NO_PROXY = originalNoProxy;
    } else {
      delete process.env.NO_PROXY;
    }
  });

  test("test_loopback_bypasses_proxy_when_no_proxy_configured", async () => {
    // Point HTTP_PROXY to a non-existent port (59999) that will refuse connections
    process.env.HTTP_PROXY = "http://127.0.0.1:59999";
    process.env.NO_PROXY = "127.0.0.1,localhost,::1";

    const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
      signal: AbortSignal.timeout(3000),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.status).toBe("isolated");
    expect(body.pathname).toBe("/health");
  });

  test("test_loopback_is_trapped_when_no_proxy_is_missing", async () => {
    // When NO_PROXY is missing, Bun routes loopback requests through HTTP_PROXY per request
    process.env.HTTP_PROXY = "http://127.0.0.1:59999";
    delete process.env.NO_PROXY;

    let hasTrapped = false;
    try {
      await fetch(`http://127.0.0.1:${server.port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch (caughtError: any) {
      hasTrapped = true;
      // Proves the request was redirected to the dead proxy port
      expect(caughtError).toBeDefined();
    }

    expect(hasTrapped).toBe(true);
  });
});
