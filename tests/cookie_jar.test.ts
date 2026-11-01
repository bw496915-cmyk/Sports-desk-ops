import { describe, expect, test } from "bun:test";
import {
  cookieHeaderFrom,
  cookiesFromHar,
  parseCookieHeader,
} from "../lib/cookie_jar.ts";

const HAR = {
  log: {
    entries: [
      {
        request: {
          url: "https://fantasy402.com/manager.html",
          headers: [
            { name: "Accept", value: "text/html" },
            { name: "Cookie", value: "session=abc; csrftoken=xyz" },
          ],
        },
      },
      {
        request: {
          url: "https://fantasy402.com/cloud/api/Manager/getInfoPlayer",
          headers: [{ name: "cookie", value: "session=abc; agent=118" }],
        },
      },
      {
        request: {
          url: "https://example.com/elsewhere",
          headers: [{ name: "Cookie", value: "other=1" }],
        },
      },
    ],
  },
};

describe("cookie jar", () => {
  test("parses a Cookie header into a CookieMap", () => {
    const map = parseCookieHeader("a=1; b=2; bare");
    expect(map.get("a")).toBe("1");
    expect(map.get("b")).toBe("2");
    // CookieMap drops a token with no `=`, so a malformed jar loses that name rather than yielding "".
    expect(map.get("bare")).toBeNull();
    expect([...map].map(([name]) => name)).toEqual(["a", "b"]);
  });

  test("serializes without the CookieMap toString trap", () => {
    const header = cookieHeaderFrom([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(header).toBe("a=1; b=2");
    expect(String(parseCookieHeader("a=1"))).toBe("[object CookieMap]");
  });

  test("extracts and merges cookies for one host from a HAR", () => {
    const cookies = cookiesFromHar(HAR, "fantasy402.com");
    const names = cookies.map((cookie) => cookie.name).sort();
    expect(names).toEqual(["agent", "csrftoken", "session"]);
    // Later entries win, so the second request's session value replaces the first.
    expect(cookies.find((cookie) => cookie.name === "agent")?.value).toBe(
      "118",
    );
    expect(cookies.some((cookie) => cookie.name === "other")).toBe(false);
  });

  test("rejects a HAR without log.entries and returns nothing for another host", () => {
    expect(() => cookiesFromHar({}, "fantasy402.com")).toThrow("log.entries");
    expect(() => cookiesFromHar(null, "fantasy402.com")).toThrow(
      "not an object",
    );
    expect(cookiesFromHar(HAR, "unknown.example")).toEqual([]);
  });
});
