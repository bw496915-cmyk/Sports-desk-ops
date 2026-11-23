/**
 * @file tests/api_base_validate.test.ts
 * @description Regression suite for `lib/api_base_validate.ts`.
 *
 * The expectations encode measured Bun 1.4.5 behaviour: `URLPattern#exec` does
 * not throw on relative input, and hostname patterns cannot express the label
 * shape, so the guard lives in JS. If a future Bun changes either fact, these
 * tests still pass — they assert the contract, not the implementation detail.
 */
import { describe, expect, test } from "bun:test";
import {
  resolveApiUrl,
  validateApiBaseWithPattern,
} from "../lib/api_base_validate.ts";

const REJECTED = [
  // Relative and protocol-relative: must fail closed, not throw.
  "//evil.com",
  "/relative",
  "evil.com",
  "https://",
  // Origin confusions.
  "https://evil.example",
  "https://sub.bookdeskops.com.evil.example",
  "https://evil-bookdeskops.com",
  "https://bookdeskops.com",
  "https://a.b.bookdeskops.com",
  "https://sub.bookdeskops.com.",
  "https://sub.bookdeskops.com..",
  "https://api.bookdeskops.com@evil.com",
  "https://evil.com@api.bookdeskops.com",
  "https://api.bookdeskops.com:1337@evil.example",
  // Port, query, fragment, credentials.
  "https://sub.bookdeskops.com:8443",
  "https://sub.bookdeskops.com:0443",
  "https://sub.bookdeskops.com:00000",
  "https://sub.bookdeskops.com:443:443",
  "https://sub.bookdeskops.com/?x=1",
  "https://sub.bookdeskops.com/?apiBase=good&apiBase=evil",
  "https://sub.bookdeskops.com/?apiBase=good%26apiBase%3Devil",
  "https://sub.bookdeskops.com#x",
  "https://user:pass@sub.bookdeskops.com",
  // Label shape and deny-list. Host case is folded by the parser before either
  // check runs, so the uppercase forms must reject identically.
  "https://staging.bookdeskops.com",
  "HTTPS://STAGING.BOOKDESKOPS.COM",
  "https://xn--80ak6aa92e.bookdeskops.com",
  "HTTPS://XN--80AK6AA92E.BOOKDESKOPS.COM",
  // U+0430 CYRILLIC SMALL LETTER A, not ASCII `a`; punycodes to an `xn--` label.
  "https://аpi.bookdeskops.com",
  "https://-foo.bookdeskops.com",
  "https://foo-.bookdeskops.com",
  // Non-http(s) schemes parse but must not be accepted.
  "javascript:alert(1)",
  "file:///etc/passwd",
  "data:text/html,hi",
  // Unparseable / out-of-range.
  "https://[::1",
  "https://sub.bookdeskops.com:99999",
  "https://sub.bookdeskops.com:65536",
  "https://api.bookdeskops.com%00.evil.com",
  "https://api.bookdeskops.com//evil.com",
  // Input hygiene.
  "https://api.bookdeskops.com\t/",
  "https://api.bookdeskops.com\n/",
  "https://api.bookdeskops.com\\@evil.com",
  "https://api.bookdeskops.com/" + "a".repeat(2_048),
  "",
  "   ",
] as const;

describe("validateApiBaseWithPattern", () => {
  test.each(REJECTED)("rejects %j without throwing", (raw) => {
    expect(() => validateApiBaseWithPattern(raw, false)).not.toThrow();
    expect(validateApiBaseWithPattern(raw, false).ok).toBe(false);
  });

  test.each([
    null,
    undefined,
    42 as unknown as string,
    {} as unknown as string,
  ])("rejects non-string %j without throwing", (raw) => {
    expect(() => validateApiBaseWithPattern(raw, false)).not.toThrow();
    expect(validateApiBaseWithPattern(raw, false).ok).toBe(false);
  });

  test("accepts a canonical production origin and extracts the subdomain", () => {
    expect(
      validateApiBaseWithPattern("https://api.bookdeskops.com", false),
    ).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com",
      sub: "api",
    });
  });

  test("strips an explicit :443 and strips trailing slashes", () => {
    expect(
      validateApiBaseWithPattern("https://api.bookdeskops.com:443", false),
    ).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com",
      sub: "api",
    });
    expect(
      validateApiBaseWithPattern("https://api.bookdeskops.com/", false),
    ).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com",
      sub: "api",
    });
  });

  test("accepts a path prefix and keeps it in the normalized base", () => {
    expect(
      validateApiBaseWithPattern("https://api.bookdeskops.com/v1/", false),
    ).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com/v1",
      sub: "api",
    });
  });

  test("scheme and host case is canonicalised, not rejected", () => {
    expect(
      validateApiBaseWithPattern("HTTPS://API.BOOKDESKOPS.COM", false),
    ).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com",
      sub: "api",
    });
  });

  test("percent-encoded and confusable labels resolve to the canonical origin", () => {
    // The parser decodes `%61`, maps U+3002 to `.`, and NFKCs `ⓐ` to `a`;
    // whatever the input, the returned base is parser output, never raw bytes.
    for (const raw of [
      "https://%61pi.bookdeskops.com",
      "https://api。bookdeskops.com",
      "https://ⓐpi.bookdeskops.com",
    ]) {
      const result = validateApiBaseWithPattern(raw, false);
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.normalized).toBe("https://api.bookdeskops.com");
    }
  });

  test("gates loopback on isLocalDev", () => {
    expect(validateApiBaseWithPattern("http://127.0.0.1:8787", true).ok).toBe(
      true,
    );
    expect(validateApiBaseWithPattern("http://127.0.0.1:8787", false).ok).toBe(
      false,
    );
  });

  test.each([
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    // `URL` strips the trailing dot on an IPv4 host, so this is the same host.
    "http://127.0.0.1.:8787",
    "http://[::1]:8787",
    "http://[0:0:0:0:0:0:0:1]:8787",
    "http://127.1:8787",
    "http://0x7f000001:8787",
    "http://2130706433:8787",
    "http://0177.0.0.1:8787",
  ])("accepts loopback form %s only in dev", (raw) => {
    const dev = validateApiBaseWithPattern(raw, true);
    expect(dev.ok).toBe(true);
    expect(validateApiBaseWithPattern(raw, false).ok).toBe(false);
  });

  test("canonicalises every loopback alias to the same base", () => {
    for (const raw of [
      "http://127.1:8787",
      "http://0x7f000001:8787",
      "http://2130706433:8787",
    ]) {
      expect(validateApiBaseWithPattern(raw, true)).toEqual({
        ok: true,
        normalized: "http://127.0.0.1:8787",
      });
    }
  });

  test("rejects an IPv4-mapped IPv6 loopback rather than guessing", () => {
    expect(
      validateApiBaseWithPattern("http://[::ffff:127.0.0.1]:8787", true).ok,
    ).toBe(false);
  });

  test.each([
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:99999",
    "http://127.0.0.1:123456",
    "http://127.0.0.1:0443",
    "http://127.0.0.1:00080",
  ])("rejects dev port %s with a dedicated code", (raw) => {
    expect(() => validateApiBaseWithPattern(raw, true)).not.toThrow();
    expect(validateApiBaseWithPattern(raw, true)).toEqual({
      ok: false,
      code: "ERR_API_BASE_INVALID_PORT",
    });
  });

  test("accepts the dev port boundaries and omits the scheme default", () => {
    for (const raw of ["http://127.0.0.1:1", "http://127.0.0.1:65535"]) {
      expect(validateApiBaseWithPattern(raw, true)).toEqual({
        ok: true,
        normalized: raw,
      });
    }
    expect(validateApiBaseWithPattern("http://127.0.0.1:80", true)).toEqual({
      ok: true,
      normalized: "http://127.0.0.1",
    });
  });

  test("keeps a valid non-default production port out, with the origin code", () => {
    for (const raw of [
      "https://api.bookdeskops.com:8443",
      "https://api.bookdeskops.com:65535",
    ]) {
      expect(validateApiBaseWithPattern(raw, false)).toEqual({
        ok: false,
        code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
      });
    }
  });

  test("uses the port code for zero-padded and out-of-range production ports", () => {
    for (const raw of [
      "https://api.bookdeskops.com:0",
      "https://api.bookdeskops.com:0443",
      "https://api.bookdeskops.com:65536",
      "https://api.bookdeskops.com:99999",
    ]) {
      expect(validateApiBaseWithPattern(raw, false)).toEqual({
        ok: false,
        code: "ERR_API_BASE_INVALID_PORT",
      });
    }
  });

  test("rejects trailing-dot hostnames explicitly", () => {
    for (const [raw, isDev] of [
      ["https://api.bookdeskops.com.", false],
      ["https://api.bookdeskops.com..", false],
      ["http://localhost.:8787", true],
    ] as const) {
      expect(validateApiBaseWithPattern(raw, isDev)).toEqual({
        ok: false,
        code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
      });
    }
  });

  test("preserves bracketed IPv6 in the normalized base", () => {
    for (const raw of ["http://[::1]:8787", "http://[0:0:0:0:0:0:0:1]:8787"]) {
      expect(validateApiBaseWithPattern(raw, true)).toEqual({
        ok: true,
        normalized: "http://[::1]:8787",
      });
    }
  });

  test("rejects auth-user-as-host shapes with the origin code", () => {
    for (const raw of [
      "https://api.bookdeskops.com:1337@evil.example",
      "https://user@api.bookdeskops.com",
      "https://api.bookdeskops.com@evil.com",
    ]) {
      expect(validateApiBaseWithPattern(raw, false)).toEqual({
        ok: false,
        code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
      });
    }
  });

  test("rejects a Cyrillic lookalike label", () => {
    expect(
      validateApiBaseWithPattern("https://аpi.bookdeskops.com", false),
    ).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    });
  });

  test("normalisation is idempotent", () => {
    const once = validateApiBaseWithPattern(
      "https://api.bookdeskops.com/v1/",
      false,
    );
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(validateApiBaseWithPattern(once.normalized, false)).toEqual(once);
  });

  test("reports PATTERN_UNAVAILABLE when the runtime has no URLPattern", () => {
    const moduleHref = new URL("../lib/api_base_validate.ts", import.meta.url)
      .href;
    const script = `
      delete globalThis.URLPattern;
      const mod = await import(${JSON.stringify(moduleHref)});
      process.stdout.write(JSON.stringify([
        mod.validateApiBaseWithPattern("https://api.bookdeskops.com", false),
        mod.validateApiBaseWithPattern("http://127.0.0.1:8787", true),
      ]));
    `;
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual([
      { ok: false, code: "ERR_API_BASE_PATTERN_UNAVAILABLE" },
      { ok: false, code: "ERR_API_BASE_PATTERN_UNAVAILABLE" },
    ]);
  });
});

describe("resolveApiUrl", () => {
  const base = "https://api.bookdeskops.com/v1";

  test.each([
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "https://evil.com/x",
    "evil.com",
    "/../admin",
    "/a/../../admin",
    "/%2e%2e/admin",
    "/%2E%2E/admin",
    "/a%2fb",
    "/a%5Cb",
    "/a#fragment",
    "/a\u0000b",
    "",
  ])("rejects path %j", (path) => {
    expect(resolveApiUrl(base, path)).toEqual({
      ok: false,
      code: "ERR_API_BASE_INVALID_URL",
    });
  });

  test("joins a normal path without moving the origin", () => {
    expect(resolveApiUrl(base, "/items?limit=2")).toEqual({
      ok: true,
      href: "https://api.bookdeskops.com/v1/items?limit=2",
    });
  });

  test("joins onto a bare origin", () => {
    expect(resolveApiUrl("https://api.bookdeskops.com", "/items")).toEqual({
      ok: true,
      href: "https://api.bookdeskops.com/items",
    });
  });

  test("refuses to join onto an invalid base", () => {
    expect(resolveApiUrl("//evil.com", "/x")).toEqual({
      ok: false,
      code: "ERR_API_BASE_INVALID_URL",
    });
  });

  test("the protocol-relative escape is closed", () => {
    // The base path this guards: `new URL("//evil.com", base).href` is evil.com.
    expect(new URL("//evil.com", base).origin).toBe("https://evil.com");
    expect(resolveApiUrl(base, "//evil.com").ok).toBe(false);
  });
});
