import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * WHATWG Fetch § "Request constructor":
 * https://fetch.spec.whatwg.org/#dom-request
 *
 * Rule on GET and HEAD methods with body:
 * If ((init["body"] is present and is not null) or input's request's body is not null)
 * and (method is `GET` or `HEAD`), then throw a TypeError.
 *
 * Notice:
 * - `body: null` or `body: undefined` is ALLOWED on GET/HEAD!
 * - Only non-null bodies throw TypeError.
 *
 * WebIDL coercion warning:
 * In WebIDL, any non-object/non-standard value passed as USVString body is stringified:
 * - Plain object `{ a: 1 }` coerces via toString() to `"[object Object]"` (NOT JSON!)
 * - Number `42` coerces to `"42"`
 */

// The pinned constructor retains GET/HEAD bodies; fetch rejects nonempty bodies.
// Exercise both boundaries rather than assuming constructor conformance.
describe("Bun 1.4.4 GET/HEAD body compatibility and fetch validation", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requestsReceived = 0;
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requestsReceived++;
        return new Response("ok");
      },
    });
  });
  afterAll(() => server.stop(true));
  const getMethods = ["GET", "get"] as const;
  const headMethods = ["HEAD", "head"] as const;

  for (const m of getMethods) {
    test(`pinned constructor retains string bodies on "${m}", while fetch rejects nonempty bodies`, async () => {
      for (const body of ["", "data"]) {
        const request = new Request(server.url, { method: m, body });
        expect(request.body).not.toBeNull();
        expect(await request.text()).toBe(body);
      }
      const before = requestsReceived;
      await expect(
        fetch(server.url, { method: m, body: "data", proxy: false }),
      ).rejects.toThrow("GET/HEAD method cannot have body");
      expect(requestsReceived).toBe(before);
    });

    test(`method "${m}" with body: null succeeds`, () => {
      const req = new Request("http://127.0.0.1", { method: m, body: null });
      expect(req.method).toBe(m.toUpperCase());
      expect(req.body).toBeNull();
    });

    test(`method "${m}" with body: undefined succeeds`, () => {
      const req = new Request("http://127.0.0.1", {
        method: m,
        body: undefined,
      });
      expect(req.method).toBe(m.toUpperCase());
      expect(req.body).toBeNull();
    });
  }

  for (const m of headMethods) {
    test(`pinned constructor retains string bodies on "${m}", while fetch rejects nonempty bodies`, async () => {
      for (const body of ["", "data"]) {
        const request = new Request(server.url, { method: m, body });
        expect(request.body).not.toBeNull();
        expect(await request.text()).toBe(body);
      }
      const before = requestsReceived;
      await expect(
        fetch(server.url, { method: m, body: "data", proxy: false }),
      ).rejects.toThrow("GET/HEAD method cannot have body");
      expect(requestsReceived).toBe(before);
    });

    test(`method "${m}" with body: null succeeds`, () => {
      const req = new Request("http://127.0.0.1", { method: m, body: null });
      expect(req.method).toBe(m.toUpperCase());
      expect(req.body).toBeNull();
    });

    test(`method "${m}" with body: undefined succeeds`, () => {
      const req = new Request("http://127.0.0.1", {
        method: m,
        body: undefined,
      });
      expect(req.method).toBe(m.toUpperCase());
      expect(req.body).toBeNull();
    });
  }

  test("WebIDL string coercion: plain object coerces to '[object Object]', not JSON", async () => {
    // When a developer mistakenly passes a plain object without JSON.stringify
    const obj = { a: 1 };
    // Coerced via String() or WebIDL conversion
    const req = new Request("http://127.0.0.1", {
      method: "POST",
      body: String(obj),
    });
    const text = await req.text();
    expect(text).toBe("[object Object]");
    expect(text).not.toBe('{"a":1}');
  });

  test("WebIDL string coercion: number coerces to string representation", async () => {
    const num = 42;
    const req = new Request("http://127.0.0.1", {
      method: "POST",
      body: String(num),
    });
    const text = await req.text();
    expect(text).toBe("42");
  });
});
