/**
 * @file lib/cookie_jar.ts
 * @description Cookie handling for the browser-free capture path (`Bun.Cookie` & `Bun.CookieMap`).
 *
 * A HAR or an exported cookie jar can authenticate the probe without WebView, which is the only way
 * to run it in CI.
 *
 * Canonical `Bun.Cookie` / `Bun.CookieMap` contract (`docs/runtime/cookies.mdx` & `bun.d.ts`):
 * - `new Bun.CookieMap(header)` parses a `Cookie` request header into an `Iterable<[string, string]>`
 *   (and `toJSON(): Record<string, string>`). `String(map)` is `"[object CookieMap]"`, so outbound
 *   `Cookie` headers are serialized explicitly.
 * - `Bun.Cookie.parse(setCookieHeader)` parses a `Set-Cookie` response header into a `Bun.Cookie`
 *   instance with `.name`, `.value`, `.domain`, `.path`, and `.isExpired()` (where `maxAge` takes
 *   RFC 6265 precedence over `expires`).
 */

export interface HarCookie {
  readonly name: string;
  readonly value: string;
}

export function parseCookieHeader(header: string): Bun.CookieMap {
  return new Bun.CookieMap(header);
}

/**
 * Parse a `Set-Cookie` response header via `Bun.Cookie.parse` and return `{ name, value }`
 * only when the cookie has not expired (`!cookie.isExpired()`).
 */
export function parseSetCookieHeader(setCookie: string): HarCookie | null {
  const trimmed = setCookie.trim();
  if (trimmed === "") return null;
  try {
    const cookie = Bun.Cookie.parse(trimmed);
    if (cookie.name === "" || cookie.isExpired()) return null;
    return { name: cookie.name, value: cookie.value };
  } catch {
    return null;
  }
}

/** Serialize a CookieMap (or any [name, value] iterable) back into a Cookie header. */
export function cookieHeaderFrom(
  cookies: Iterable<readonly [string, string]>,
): string {
  return [...cookies]
    .filter(([name]) => name !== "")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Cookies a HAR's requests sent to `host` (via `Bun.CookieMap`), plus any non-expired
 * `Set-Cookie` headers returned by `host` (via `Bun.Cookie.parse` + `cookie.isExpired()`).
 */
export function cookiesFromHar(har: unknown, host: string): HarCookie[] {
  if (!isRecord(har)) throw new Error("HAR is not an object");
  const log = har["log"];
  if (!isRecord(log) || !Array.isArray(log["entries"])) {
    throw new Error("HAR is missing log.entries");
  }

  const merged = new Map<string, string>();
  for (const entry of log["entries"]) {
    if (!isRecord(entry)) continue;
    const request = entry["request"];
    if (!isRecord(request)) continue;
    const url = request["url"];
    if (typeof url !== "string") continue;
    let entryHost = "";
    try {
      entryHost = new URL(url).host;
    } catch {
      continue;
    }
    if (entryHost !== host) continue;

    const headers = request["headers"];
    if (Array.isArray(headers)) {
      for (const header of headers) {
        if (!isRecord(header)) continue;
        const name = header["name"];
        if (typeof name !== "string" || name.toLowerCase() !== "cookie")
          continue;
        const value = header["value"];
        if (typeof value !== "string") continue;
        for (const [cookieName, cookieValue] of parseCookieHeader(value)) {
          merged.set(cookieName, cookieValue);
        }
      }
    }

    const response = entry["response"];
    if (isRecord(response) && Array.isArray(response["headers"])) {
      for (const header of response["headers"]) {
        if (!isRecord(header)) continue;
        const name = header["name"];
        if (typeof name !== "string" || name.toLowerCase() !== "set-cookie")
          continue;
        const value = header["value"];
        if (typeof value !== "string") continue;
        const parsed = parseSetCookieHeader(value);
        if (parsed !== null) merged.set(parsed.name, parsed.value);
      }
    }
  }

  return [...merged].map(([name, value]) => ({ name, value }));
}

/**
 * Extract the last non-redacted `Authorization: Bearer <token>` header sent to `host` in a HAR.
 * Returns `null` when absent or redacted (`<redacted>`).
 */
export function bearerFromHar(har: unknown, host: string): string | null {
  if (!isRecord(har)) return null;
  const log = har["log"];
  if (!isRecord(log) || !Array.isArray(log["entries"])) return null;

  let bearer: string | null = null;
  for (const entry of log["entries"]) {
    if (!isRecord(entry)) continue;
    const request = entry["request"];
    if (!isRecord(request)) continue;
    const url = request["url"];
    if (typeof url !== "string") continue;
    let entryHost = "";
    try {
      entryHost = new URL(url).host;
    } catch {
      continue;
    }
    if (entryHost !== host) continue;
    const headers = request["headers"];
    if (!Array.isArray(headers)) continue;
    for (const header of headers) {
      if (!isRecord(header)) continue;
      const name = header["name"];
      const value = header["value"];
      if (
        typeof name === "string" &&
        name.toLowerCase() === "authorization" &&
        typeof value === "string"
      ) {
        const trimmed = value.trim();
        if (
          /^Bearer\s+\S+/i.test(trimmed) &&
          !trimmed.toLowerCase().includes("redacted")
        ) {
          bearer = trimmed;
        }
      }
    }
  }
  return bearer;
}
