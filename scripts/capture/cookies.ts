/**
 * Cookie handoff between the authenticated WebView (CDP) and the FetchSession
 * data path.
 *
 * Values are needed exactly once — to build the `Cookie` request header for a
 * replay — and are never persisted, logged or summarized. Everything that leaves
 * this module is a name/count/redacted-header view.
 */

import { isPlainObject } from "./json.ts";
import { REDACTED } from "./redact.ts";

export class CookieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieError";
  }
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expires?: number;
  session?: boolean;
}

export interface CookieSummary {
  count: number;
  names: string[];
  headerPresent: boolean;
  /** e.g. `session=<redacted>; csrftoken=<redacted>` — never raw values. */
  redactedHeader: string;
}

/** Validate the `Network.getAllCookies` CDP result into typed cookies. */
export function parseCdpCookies(result: unknown): CdpCookie[] {
  if (!isPlainObject(result)) {
    throw new CookieError("CDP Network.getAllCookies returned a non-object");
  }
  const rawCookies = result["cookies"];
  if (!Array.isArray(rawCookies)) {
    throw new CookieError(
      "CDP Network.getAllCookies result is missing a cookies array",
    );
  }
  const cookies: CdpCookie[] = [];
  for (const raw of rawCookies) {
    if (!isPlainObject(raw)) {
      throw new CookieError("CDP cookie entry is not an object");
    }
    const name = raw["name"];
    const value = raw["value"];
    if (typeof name !== "string" || name.length === 0) {
      throw new CookieError("CDP cookie entry has no usable name");
    }
    if (typeof value !== "string") {
      throw new CookieError(`CDP cookie "${name}" has a non-string value`);
    }
    const cookie: CdpCookie = {
      name,
      value,
      domain: typeof raw["domain"] === "string" ? raw["domain"] : "",
      path: typeof raw["path"] === "string" ? raw["path"] : "/",
      httpOnly: raw["httpOnly"] === true,
      secure: raw["secure"] === true,
    };
    if (typeof raw["expires"] === "number") cookie.expires = raw["expires"];
    if (typeof raw["session"] === "boolean") cookie.session = raw["session"];
    cookies.push(cookie);
  }
  return cookies;
}

function stripPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing !== -1) return trimmed.slice(0, closing + 1);
  }
  return trimmed.replace(/:\d+$/, "");
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length === 0) return true;
  const normalizedHost = host.replace(/\.$/, "");
  if (domain.startsWith(".")) {
    const suffix = domain.slice(1);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
}

/**
 * Select the cookies whose domain/path scope covers a request. Expired cookies
 * are dropped. Setting `now` makes the expiry decision testable.
 */
export function selectCookiesForHost(
  cookies: readonly CdpCookie[],
  host: string,
  requestPath = "/",
  now: number = Date.now(),
): CdpCookie[] {
  const normalizedHost = stripPort(host);
  const selected = cookies.filter((cookie) => {
    if (!domainMatches(cookie.domain, normalizedHost)) return false;
    if (!requestPath.startsWith(cookie.path)) return false;
    if (cookie.expires !== undefined && cookie.expires > 0) {
      if (cookie.expires * 1000 <= now) return false;
    }
    return true;
  });
  return selected.sort((left, right) => left.name.localeCompare(right.name));
}

/** Build a `Cookie` header value from selected cookies. */
export function buildCookieHeader(cookies: readonly CdpCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/** Redact every cookie value while preserving the names for diagnostics. */
export function redactCookieHeader(header: string): string {
  const trimmed = header.trim();
  if (trimmed.length === 0) return "";
  return trimmed
    .split(";")
    .map((part) => {
      const equals = part.indexOf("=");
      if (equals <= 0) return REDACTED;
      return `${part.slice(0, equals).trim()}=${REDACTED}`;
    })
    .join("; ");
}

/** Cookie names only — the only cookie shape that is ever persisted. */
export function summarizeCookies(
  cookies: readonly CdpCookie[],
  header: string = buildCookieHeader(cookies),
): CookieSummary {
  const names = [...new Set(cookies.map((cookie) => cookie.name))].sort();
  return {
    count: cookies.length,
    names,
    headerPresent: header.trim().length > 0,
    redactedHeader: redactCookieHeader(header),
  };
}

export interface CookieHandoff {
  header: string;
  summary: CookieSummary;
}

/**
 * Produce the session cookie header for one host, or throw when the
 * authenticated browser has no scoped cookies (better than capturing 401s).
 */
export function cookieHandoffForHost(
  cookies: readonly CdpCookie[],
  host: string,
  requestPath = "/",
  now?: number,
): CookieHandoff {
  const selected =
    now === undefined
      ? selectCookiesForHost(cookies, host, requestPath)
      : selectCookiesForHost(cookies, host, requestPath, now);
  const header = buildCookieHeader(selected);
  if (header.length === 0) {
    throw new CookieError(
      `no session cookies were scoped to ${stripPort(host) || "<unknown host>"} after login`,
    );
  }
  return { header, summary: summarizeCookies(selected, header) };
}
