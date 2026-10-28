import { describe, expect, test } from "bun:test";

/**
 * WHATWG Fetch § "normalize a method":
 * https://fetch.spec.whatwg.org/#concept-method-normalize
 *
 * To normalize a method, if the method is a byte-case-insensitive match for:
 * - "DELETE"
 * - "GET"
 * - "HEAD"
 * - "OPTIONS"
 * - "POST"
 * - "PUT"
 * then return the method converted to ASCII uppercase.
 * Otherwise, return the method AS-IS (case preserved).
 *
 * Notice: "PATCH" is NOT in the six-method normalization set.
 * A lowercase "patch" remains "patch" on the wire, which some servers reject.
 * Code rule: ALWAYS specify HTTP methods in explicit uppercase.
 *
 * WHATWG Fetch § "Request constructor":
 * Forbidden methods that unconditionally throw TypeError:
 * - "CONNECT"
 * - "TRACE"
 * - "TRACK"
 */

describe("RequestInit method normalization and forbidden methods", () => {
  const normalizationCases = [
    { input: "post", expected: "POST", note: "Normalized to uppercase (in six-method set)" },
    { input: "POST", expected: "POST", note: "Explicit uppercase preserved" },
    { input: "Delete", expected: "DELETE", note: "Normalized to uppercase (in six-method set)" },
    { input: "delete", expected: "DELETE", note: "Normalized to uppercase (in six-method set)" },
    { input: "get", expected: "GET", note: "Normalized to uppercase (in six-method set)" },
    { input: "head", expected: "HEAD", note: "Normalized to uppercase (in six-method set)" },
    { input: "options", expected: "OPTIONS", note: "Normalized to uppercase (in six-method set)" },
    { input: "put", expected: "PUT", note: "Normalized to uppercase (in six-method set)" },
    // PATCH is outside the six-method set!
    { input: "PATCH", expected: "PATCH", note: "Explicit uppercase PATCH preserved" },
    { input: "patch", expected: "patch", note: "LOWERCASE PRESERVED: PATCH is NOT in WHATWG normalization set!" },
    // Non-standard / custom verbs preserve casing
    { input: "propfind", expected: "propfind", note: "Custom / WebDAV method preserves lowercase" },
    { input: "PROPFIND", expected: "PROPFIND", note: "Custom / WebDAV method preserves uppercase" },
  ];

  for (const { input, expected, note } of normalizationCases) {
    test(`method "${input}" resolves to "${expected}" (${note})`, () => {
      const req = new Request("http://127.0.0.1", { method: input });
      expect(req.method).toBe(expected);
    });
  }

  const forbiddenMethods = ["CONNECT", "TRACE", "TRACK", "connect", "trace", "track"];

  for (const forbidden of forbiddenMethods) {
    test(`forbidden method "${forbidden}" throws TypeError`, () => {
      expect(() => {
        new Request("http://127.0.0.1", { method: forbidden });
      }).toThrow(TypeError);
    });
  }
});
