import { describe, expect, test } from "bun:test";

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

describe("RequestInit GET/HEAD body constraints and WebIDL coercion", () => {
  const getMethods = ["GET", "get"] as const;
  const headMethods = ["HEAD", "head"] as const;

  for (const m of getMethods) {
    test(`method "${m}" with non-null string body throws TypeError`, () => {
      expect(() => {
        new Request("http://127.0.0.1", { method: m, body: "" });
      }).toThrow(TypeError);

      expect(() => {
        new Request("http://127.0.0.1", { method: m, body: "data" });
      }).toThrow(TypeError);
    });

    test(`method "${m}" with body: null succeeds`, () => {
      const req = new Request("http://127.0.0.1", { method: m, body: null });
      expect(req.method).toBe(m.toUpperCase());
      expect(req.body).toBeNull();
    });

    test(`method "${m}" with body: undefined succeeds`, () => {
      const req = new Request("http://127.0.0.1", { method: m, body: undefined });
      expect(req.method).toBe(m.toUpperCase());
      expect(req.body).toBeNull();
    });
  }

  for (const m of headMethods) {
    test(`method "${m}" with non-null string body throws TypeError`, () => {
      expect(() => {
        new Request("http://127.0.0.1", { method: m, body: "" });
      }).toThrow(TypeError);

      expect(() => {
        new Request("http://127.0.0.1", { method: m, body: "data" });
      }).toThrow(TypeError);
    });

    test(`method "${m}" with body: null succeeds`, () => {
      const req = new Request("http://127.0.0.1", { method: m, body: null });
      expect(req.method).toBe(m.toUpperCase());
      expect(req.body).toBeNull();
    });

    test(`method "${m}" with body: undefined succeeds`, () => {
      const req = new Request("http://127.0.0.1", { method: m, body: undefined });
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
      body: String(obj) as unknown as BodyInit,
    });
    const text = await req.text();
    expect(text).toBe("[object Object]");
    expect(text).not.toBe('{"a":1}');
  });

  test("WebIDL string coercion: number coerces to string representation", async () => {
    const num = 42;
    const req = new Request("http://127.0.0.1", {
      method: "POST",
      body: String(num) as unknown as BodyInit,
    });
    const text = await req.text();
    expect(text).toBe("42");
  });
});
