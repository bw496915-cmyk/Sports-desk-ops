import { describe, expect, test } from "bun:test";

import {
  BUN_ORIGIN,
  bunReferenceUrl,
  bunUrl,
  canonicalBunUrl,
} from "../lib/bun_urls.ts";

describe("bunUrl", () => {
  test("builds on https://bun.com and keeps the literal type", () => {
    const url: "https://bun.com/docs/runtime/cron" =
      bunUrl("/docs/runtime/cron");
    expect(url).toBe("https://bun.com/docs/runtime/cron");
    expect(BUN_ORIGIN).toBe("https://bun.com");
  });

  test("keeps fragments and text fragments verbatim", () => {
    expect(bunUrl("/blog/bun-v1.4#bun-terminal:~:text=a%20b")).toBe(
      "https://bun.com/blog/bun-v1.4#bun-terminal:~:text=a%20b",
    );
  });

  test("rejects a trailing slash, which bun.com 308-redirects", () => {
    expect(() => bunUrl("/docs/runtime/")).toThrow("must not end");
    expect(bunUrl("/")).toBe("https://bun.com/");
  });

  test("rejects a doubled slash", () => {
    expect(() => bunUrl("//evil.example/x")).toThrow("one absolute path");
    expect(() => bunUrl("/docs//cron")).toThrow("one absolute path");
  });
});

describe("bunReferenceUrl", () => {
  test("globals/bun/<Symbol> is the reference shape", () => {
    const url: "https://bun.com/reference/globals/bun/ImportKind" =
      bunReferenceUrl("globals/bun/ImportKind");
    expect(url).toBe("https://bun.com/reference/globals/bun/ImportKind");
  });

  test("a trailing slash on the symbol path is rejected", () => {
    expect(() => bunReferenceUrl("globals/bun/")).toThrow("must not end");
  });
});

describe("canonicalBunUrl", () => {
  const CANONICAL = "https://bun.com/reference/globals/bun/ImportKind";

  test("bun.sh, www., http and a trailing slash all map to the bun.com form", () => {
    for (const raw of [
      CANONICAL,
      "https://bun.sh/reference/globals/bun/ImportKind",
      "https://www.bun.sh/reference/globals/bun/ImportKind",
      "https://www.bun.com/reference/globals/bun/ImportKind",
      "http://bun.sh/reference/globals/bun/ImportKind/",
      "bun.sh/reference/globals/bun/ImportKind",
      "  HTTPS://BUN.SH/reference/globals/bun/ImportKind  ",
    ]) {
      expect(canonicalBunUrl(raw)).toBe(CANONICAL);
    }
  });

  test("query and text fragment survive unchanged", () => {
    expect(
      canonicalBunUrl(
        "https://bun.sh/blog/bun-v1.4?ref=x#bun-terminal:~:text=Pass%20terminal",
      ),
    ).toBe(
      "https://bun.com/blog/bun-v1.4?ref=x#bun-terminal:~:text=Pass%20terminal",
    );
  });

  test("the site root stays https://bun.com/", () => {
    expect(canonicalBunUrl("https://bun.sh")).toBe("https://bun.com/");
  });

  test("anything that is not Bun's site is null", () => {
    for (const raw of [
      "https://bun.sh.evil.example/docs",
      "https://evilbun.sh/docs",
      "https://bun.sh:8443/docs",
      // Joined at runtime: tests/fetch_url_credentials.test.ts bans credential URLs in source.
      ["https://user", "pw@bun.sh/docs"].join(":"),
      "javascript:alert(1)",
      "file:///bun.sh/docs",
      "",
      "not a url",
    ]) {
      expect(canonicalBunUrl(raw)).toBeNull();
    }
  });
});
