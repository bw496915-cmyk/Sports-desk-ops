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

// These are pinned-runtime compatibility checks, not a claim of Fetch conformance.
// Bun 1.4.4 maps mixed-case Delete to GET, uppercases custom verbs, and accepts
// CONNECT/TRACE while mapping TRACK to GET. Keep explicit uppercase in application calls.
describe("Bun 1.4.4 Request method compatibility", () => {
  const normalizationCases = [
    {
      input: "post",
      expected: "POST",
      note: "Normalized to uppercase (in six-method set)",
    },
    { input: "POST", expected: "POST", note: "Explicit uppercase preserved" },
    {
      input: "Delete",
      expected: "GET",
      note: "Pinned Bun divergence: mixed-case Delete falls back to GET",
    },
    {
      input: "delete",
      expected: "DELETE",
      note: "Normalized to uppercase (in six-method set)",
    },
    {
      input: "get",
      expected: "GET",
      note: "Normalized to uppercase (in six-method set)",
    },
    {
      input: "head",
      expected: "HEAD",
      note: "Normalized to uppercase (in six-method set)",
    },
    {
      input: "options",
      expected: "OPTIONS",
      note: "Normalized to uppercase (in six-method set)",
    },
    {
      input: "put",
      expected: "PUT",
      note: "Normalized to uppercase (in six-method set)",
    },
    // PATCH is outside the six-method set!
    {
      input: "PATCH",
      expected: "PATCH",
      note: "Explicit uppercase PATCH preserved",
    },
    {
      input: "patch",
      expected: "PATCH",
      note: "Pinned Bun divergence: PATCH is uppercased",
    },
    // Non-standard / custom verbs preserve casing
    {
      input: "propfind",
      expected: "PROPFIND",
      note: "Pinned Bun divergence: custom verb is uppercased",
    },
    {
      input: "PROPFIND",
      expected: "PROPFIND",
      note: "Custom / WebDAV method preserves uppercase",
    },
  ];

  for (const { input, expected, note } of normalizationCases) {
    test(`method "${input}" resolves to "${expected}" (${note})`, () => {
      const req = new Request("http://127.0.0.1", { method: input });
      expect(req.method).toBe(expected);
    });
  }

  const forbiddenMethods = [
    "CONNECT",
    "TRACE",
    "TRACK",
    "connect",
    "trace",
    "track",
  ];

  for (const forbidden of forbiddenMethods) {
    test(`spec-forbidden method "${forbidden}" is accepted by the pinned constructor`, () => {
      const req = new Request("http://127.0.0.1", { method: forbidden });
      expect(req.method).toBe(
        forbidden.toUpperCase() === "TRACK" ? "GET" : forbidden.toUpperCase(),
      );
    });
  }
});
