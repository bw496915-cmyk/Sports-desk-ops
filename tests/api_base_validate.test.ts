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
  BOOKDESKOPS_API_BASE_POLICY,
  createApiBaseValidator,
  resolveApiUrl,
  validateApiBaseWithPattern,
  type ApiBasePolicy,
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

const CUSTOM_POLICY: ApiBasePolicy = {
  production: {
    protocols: ["https:"],
    suffix: ".example.test",
    label: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    deniedSubdomains: new Set(["staging"]),
    port: "default-only",
  },
  development: {
    protocols: ["http:", "https:"],
    hosts: new Set(["dev.internal", "localhost"]),
    port: "any-valid",
  },
  maxInputLength: 2_048,
};

/** Short, stable test names; the length-cap fixture is 2 KB. */
function labelOf(raw: string): string {
  const shown = raw.length > 48 ? `${raw.slice(0, 45)}…` : raw;
  return JSON.stringify(shown);
}

describe("validateApiBaseWithPattern", () => {
  for (const raw of REJECTED) {
    test(`rejects ${labelOf(raw)} without throwing`, () => {
      expect(() => validateApiBaseWithPattern(raw, false)).not.toThrow();
      expect(validateApiBaseWithPattern(raw, false).ok).toBe(false);
    });
  }

  const NON_STRINGS: readonly unknown[] = [null, undefined, 42, {}];
  for (const raw of NON_STRINGS) {
    const shown = JSON.stringify(raw) ?? String(raw);
    test(`rejects non-string ${shown} without throwing`, () => {
      // A boundary validator must survive a caller that bypassed the types.
      const value = raw as string | null | undefined;
      expect(() => validateApiBaseWithPattern(value, false)).not.toThrow();
      expect(validateApiBaseWithPattern(value, false).ok).toBe(false);
    });
  }

  test("trims surrounding whitespace before parsing", () => {
    expect(
      validateApiBaseWithPattern("  https://api.bookdeskops.com  ", false),
    ).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com",
      sub: "api",
    });
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

  test("allows dev HTTPS on loopback but not production", () => {
    expect(validateApiBaseWithPattern("https://localhost:8787", true)).toEqual({
      ok: true,
      normalized: "https://localhost:8787",
    });
    expect(validateApiBaseWithPattern("https://127.0.0.1:8787", true).ok).toBe(
      true,
    );
    expect(
      validateApiBaseWithPattern("https://api.bookdeskops.com", true),
    ).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    });
  });

  test("rejects HTTP on a production host", () => {
    expect(
      validateApiBaseWithPattern("http://api.bookdeskops.com", false),
    ).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    });
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

  test("reports PATTERN_UNAVAILABLE when the URLPattern constructor is unavailable", () => {
    const validator = createApiBaseValidator(BOOKDESKOPS_API_BASE_POLICY, {
      patternCtor: null,
    });
    for (const [raw, mode] of [
      ["https://api.bookdeskops.com", "production"],
      ["http://127.0.0.1:8787", "development"],
    ] as const) {
      expect(validator.validate(raw, mode)).toEqual({
        ok: false,
        code: "ERR_API_BASE_PATTERN_UNAVAILABLE",
      });
    }
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

  test("joins a loopback base in development mode", () => {
    expect(resolveApiUrl("http://127.0.0.1:8787", "/items", true)).toEqual({
      ok: true,
      href: "http://127.0.0.1:8787/items",
    });
  });

  test("rejects an over-long endpoint path", () => {
    expect(resolveApiUrl(base, "/" + "a".repeat(2_048))).toEqual({
      ok: false,
      code: "ERR_API_BASE_INVALID_URL",
    });
  });
});

describe("createApiBaseValidator", () => {
  const validator = createApiBaseValidator(CUSTOM_POLICY);

  test("uses the configured production suffix and deny-list", () => {
    expect(
      validator.validate("https://api.example.test", "production"),
    ).toEqual({
      ok: true,
      normalized: "https://api.example.test",
      sub: "api",
    });
    expect(
      validator.validate("https://api.bookdeskops.com", "production"),
    ).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    });
    expect(
      validator.validate("https://staging.example.test", "production"),
    ).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    });
  });

  test("uses the configured development hosts and protocols", () => {
    expect(
      validator.validate("http://dev.internal:8787", "development"),
    ).toEqual({
      ok: true,
      normalized: "http://dev.internal:8787",
    });
    expect(
      validator.validate("https://dev.internal:8787", "development"),
    ).toEqual({
      ok: true,
      normalized: "https://dev.internal:8787",
    });
    expect(validator.validate("http://127.0.0.1:8787", "development")).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    });
  });

  test("separates protocol policy from hostname policy", () => {
    expect(validator.validate("http://api.example.test", "production")).toEqual(
      {
        ok: false,
        code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
      },
    );
    expect(validator.validate("ftp://dev.internal", "development")).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    });
  });

  test("keeps production on the default port and development open", () => {
    expect(
      validator.validate("https://api.example.test:8443", "production"),
    ).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    });
    expect(
      validator.validate("https://dev.internal:8443", "development"),
    ).toEqual({
      ok: true,
      normalized: "https://dev.internal:8443",
    });
  });

  test("snapshots the policy at construction", () => {
    const denied = new Set(["staging"]);
    const hosts = new Set(["dev.internal"]);
    const policy: ApiBasePolicy = {
      ...CUSTOM_POLICY,
      production: { ...CUSTOM_POLICY.production, deniedSubdomains: denied },
      development: { ...CUSTOM_POLICY.development, hosts },
    };
    const frozen = createApiBaseValidator(policy);
    denied.add("api");
    hosts.delete("dev.internal");

    expect(frozen.validate("https://api.example.test", "production").ok).toBe(
      true,
    );
    expect(frozen.validate("http://dev.internal:8787", "development").ok).toBe(
      true,
    );
  });

  test("rejects a malformed policy at construction", () => {
    expect(() =>
      createApiBaseValidator({
        ...CUSTOM_POLICY,
        production: { ...CUSTOM_POLICY.production, suffix: "example.test" },
      }),
    ).toThrow("production.suffix must start with a dot");
  });

  test("rejects a port-policy typo instead of failing open", () => {
    // Deliberately type-invalid: a JavaScript caller can pass this.
    const policy = {
      ...CUSTOM_POLICY,
      production: { ...CUSTOM_POLICY.production, port: "any-valid" },
    } as unknown as ApiBasePolicy;
    expect(() => createApiBaseValidator(policy)).toThrow(
      'production.port must be "default-only"',
    );
  });

  test("rejects a development port-policy typo instead of failing open", () => {
    const policy = {
      ...CUSTOM_POLICY,
      development: { ...CUSTOM_POLICY.development, port: "default-only" },
    } as unknown as ApiBasePolicy;
    expect(() => createApiBaseValidator(policy)).toThrow(
      'development.port must be "any-valid"',
    );
  });

  test("rejects a non-RegExp label instead of matching everything", () => {
    const policy = {
      ...CUSTOM_POLICY,
      production: { ...CUSTOM_POLICY.production, label: "^[a-z]+$" },
    } as unknown as ApiBasePolicy;
    expect(() => createApiBaseValidator(policy)).toThrow(
      "production.label must be a RegExp",
    );
  });

  test("rejects a suffix containing pattern metacharacters", () => {
    expect(() =>
      createApiBaseValidator({
        ...CUSTOM_POLICY,
        production: { ...CUSTOM_POLICY.production, suffix: ".exa{mple.test" },
      }),
    ).toThrow(
      "production.suffix must be lower-case dot-separated hostname labels",
    );
  });

  test.each([0, -1, 1.5, Number.NaN] as const)(
    "rejects maxInputLength %p",
    (maxInputLength) => {
      expect(() =>
        createApiBaseValidator({ ...CUSTOM_POLICY, maxInputLength }),
      ).toThrow("maxInputLength must be a positive safe integer");
    },
  );
});
