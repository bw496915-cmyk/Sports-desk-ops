/**
 * @file lib/cookie_jar.ts
 * @description Cookie handling for the browser-free capture path.
 *
 * A HAR or an exported cookie jar can authenticate the probe without WebView, which is the only way
 * to run it in CI. `Bun.CookieMap` parses a header string; `toString()` on it yields
 * `[object CookieMap]`, so the header is serialized here explicitly.
 */

export interface HarCookie {
  readonly name: string;
  readonly value: string;
}

export function parseCookieHeader(header: string): Bun.CookieMap {
  return new Bun.CookieMap(header);
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
 * Cookies a HAR's requests sent to `host`.
 *
 * Reads the `Cookie` request header rather than `request.cookies`: the header is what the server
 * actually saw, and HAR exporters disagree about populating the structured field.
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
    if (!Array.isArray(headers)) continue;
    for (const header of headers) {
      if (!isRecord(header)) continue;
      const name = header["name"];
      if (typeof name !== "string" || name.toLowerCase() !== "cookie") continue;
      const value = header["value"];
      if (typeof value !== "string") continue;
      for (const [cookieName, cookieValue] of parseCookieHeader(value)) {
        merged.set(cookieName, cookieValue);
      }
    }
  }

  return [...merged].map(([name, value]) => ({ name, value }));
}
