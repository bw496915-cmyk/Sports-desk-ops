import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("Server Error Boundary & Non-Error Exception Handling", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    // Start server in production mode (NODE_ENV=production, development=false)
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("test_assert_thrown_non_error_in_production_returns_structured_500_without_stack_trace", async () => {
    // Request endpoint configured to throw a non-Error value (primitive string)
    const res = await fetch(`${server.url}api/test/error`);

    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;

    // 1. Assert response is structured JSON with standard contract
    expect(body).toBeObject();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Internal Server Error");
    expect(body.message).toBe("Synthetic non-Error thrown in handler");

    // 2. Assert NO stack trace is leaked in production JSON body
    expect(body).not.toHaveProperty("stack");
    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("stack");
    expect(JSON.stringify(body)).not.toContain("at ");
  });

  test("test_assert_triggered_non_error_via_query_param_in_production", async () => {
    const res = await fetch(`${server.url}health?trigger_error=non_error`);

    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.error).toBe("Internal Server Error");
    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("stack");
  });
});
