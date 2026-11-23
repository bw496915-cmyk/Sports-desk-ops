/**
 * @file lib/api_base_validate.ts
 * @description Fail-closed validation of a BookDeskOps API base origin.
 *
 * Check order is deliberate:
 *   1. cheap input hygiene — type, length, C0 controls, backslash,
 *   2. pattern availability,
 *   3. raw authority port range and leading-zero check, so a bad port returns
 *      `ERR_API_BASE_INVALID_PORT` before `new URL()` can collapse it into a
 *      generic parse error,
 *   4. exactly one `new URL()` parse, the only step that can throw,
 *   5. explicit trailing-dot hostname rejection,
 *   6. `URLPattern` over the canonical serialisation for the origin-wide fields
 *      (scheme, credentials, port, query, fragment, path), plus a canonical
 *      hostname identity check,
 *   7. a JS label check for the subdomain, because Bun 1.4.5 cannot express a
 *      hyphenated label shape in a hostname pattern (see `PROD_LABEL`).
 *
 * Parsing before matching is not cosmetic. Measured on Bun 1.4.5, the repo pin:
 * `URLPattern#exec` returns `null` (never throws) for relative or unparseable
 * input, while `new URL()` throws. Parsing first gives one known failure point
 * and one parser, so the URL whose origin is returned is the URL that was
 * validated. `URLPattern` still re-parses, but it re-parses `url.href` — this
 * parser's own canonical output, not attacker-chosen bytes.
 *
 * Do not "simplify" this by moving the hostname into the pattern: on Bun 1.4.5
 * `:sub([a-z0-9-]+)` throws `Unable to create RegExp object`, hostname
 * alternation (`{localhost|127.0.0.1}`) throws `Name position ...`, and an IPv6
 * hostname literal throws `Name position ...`. A numeric port group is the one
 * exception: it works, and the dev pattern uses it.
 *
 * Do not gate startup on `URLPattern#hasRegExpGroups` either: it is `false` for
 * these patterns by design (no regexp groups), so asserting it would disable the
 * validator. Do not pass `{ ignoreCase: true }`: `url.href` is already
 * canonical, and the option also makes pathname matching case-insensitive.
 */

/** Rejection codes are stable; callers may switch on them. */
export type ApiBaseRejectCode =
  | "ERR_API_BASE_INVALID_URL"
  | "ERR_API_BASE_INVALID_PORT"
  | "ERR_API_BASE_ORIGIN_UNTRUSTED"
  | "ERR_API_BASE_PATTERN_UNAVAILABLE";

export interface ApiBaseAccepted {
  readonly ok: true;
  /** Canonical origin plus path prefix, never with a trailing slash. */
  readonly normalized: string;
  /** Present only for an accepted production host. */
  readonly sub?: string;
}

export interface ApiBaseRejected {
  readonly ok: false;
  readonly code: ApiBaseRejectCode;
}

export type ApiBaseValidation = ApiBaseAccepted | ApiBaseRejected;

export interface ResolvedApiUrl {
  readonly ok: true;
  readonly href: string;
}

export type ApiUrlResult = ResolvedApiUrl | ApiBaseRejected;

/** Bounds the work an oversized config value can cause; no real base is close. */
const MAX_INPUT_LENGTH = 2_048;

/** C0 controls, DEL and backslash: `URL` strips the first two and rewrites `\` to `/`. */
const UNSAFE_INPUT = /[\u0000-\u001f\u007f\\]/u;

/** Path characters that would change request semantics if passed through. */
const UNSAFE_PATH = /[\u0000-\u001f\u007f\\#]/u;

/** Dot segments and percent-encoded separators: traversal / prefix escape. */
const UNSAFE_PATH_ENCODING = /(?:^|\/)\.{1,2}(?:\/|$)|%(?:2e|2f|5c)/iu;

const PROD_SUFFIX = ".bookdeskops.com";

/**
 * 1–63 characters, alphanumeric at both ends, hyphens only inside.
 * The hostname pattern cannot enforce this on Bun 1.4.5, so it lives here.
 */
const PROD_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const DENIED_SUBS: ReadonlySet<string> = new Set(["staging"]);

/**
 * Loopback names after URL canonicalisation. Aliases such as `127.1`,
 * `0x7f000001`, `2130706433` and `0177.0.0.1` all canonicalise to `127.0.0.1`
 * and are therefore accepted; `[::ffff:7f00:1]` is not, which fails closed.
 */
const DEV_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * 1–65535, no leading zero. Measured on Bun 1.4.5: a numeric `port` group is
 * accepted by `URLPattern`, unlike hostname groups, so the dev pattern can
 * express the range itself.
 */
const DEV_PORT =
  "(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";

/**
 * Port text from the authority before `new URL()` can throw. `new URL()` has no
 * representation for an out-of-range port, so this is the only place to return
 * a distinct rejection code. The userinfo group is greedy so `:1337@host` is
 * not mistaken for a port.
 */
const RAW_AUTHORITY_PORT =
  /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*@)?(?:\[[^\]]*\]|[^/?#:]*):([0-9]+)(?:[/?#]|$)/iu;

function hasInvalidRawPort(raw: string): boolean {
  const match = RAW_AUTHORITY_PORT.exec(raw);
  if (match === null) return false;
  const text = match[1]!;
  // Leading zeros are aliases: `:0443` is `:443`, `:00080` is `:80`.
  if (text.length > 1 && text.startsWith("0")) return true;
  const port = Number(text);
  return !Number.isSafeInteger(port) || port < 1 || port > 65_535;
}

interface Patterns {
  readonly prod: URLPattern | undefined;
  readonly dev: URLPattern | undefined;
}

let prodPattern: URLPattern | undefined;
let devPattern: URLPattern | undefined;
let patternsUnavailable = false;

function patterns(): Patterns {
  if (patternsUnavailable) return { prod: undefined, dev: undefined };
  if (prodPattern !== undefined && devPattern !== undefined) {
    return { prod: prodPattern, dev: devPattern };
  }
  try {
    prodPattern = new URLPattern({
      protocol: "https",
      username: "",
      password: "",
      // `:sub` binds exactly one label (measured: a.b.bookdeskops.com does not
      // match). Shape, `xn--` and the deny-list are checked below.
      hostname: ":sub.bookdeskops.com",
      port: "",
      pathname: "{/*}?",
      search: "",
      hash: "",
    });
    // Hostname is `*` and checked against DEV_HOSTS afterwards; a hostname
    // pattern cannot enumerate localhost / 127.0.0.1 / [::1] on this runtime.
    // The port group is safe, and it rejects `:0` and every value above 65535
    // even if a future edit applies the pattern to raw input.
    devPattern = new URLPattern({
      protocol: "http",
      username: "",
      password: "",
      hostname: "*",
      port: `:port(${DEV_PORT})?`,
      pathname: "{/*}?",
      search: "",
      hash: "",
    });
  } catch {
    // Older runtime without URLPattern, or an engine-specific pattern failure.
    // One failed pattern disables all of them: a half-initialised pair is how a
    // validator starts accepting things it cannot check.
    patternsUnavailable = true;
    prodPattern = undefined;
    devPattern = undefined;
  }
  return { prod: prodPattern, dev: devPattern };
}

function reject(code: ApiBaseRejectCode): ApiBaseRejected {
  return { ok: false, code };
}

function accept(normalized: string, sub?: string): ApiBaseAccepted {
  return sub === undefined
    ? { ok: true, normalized }
    : { ok: true, normalized, sub };
}

/**
 * Origin plus a trailing-slash-free path prefix; never a trailing `/`.
 * `url.origin` already omits the default port and keeps IPv6 brackets, so do
 * not rebuild this from `hostname` and `port`.
 */
function canonicalBase(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/** Single label directly left of `.bookdeskops.com`, or `undefined`. */
function subdomainOf(hostname: string): string | undefined {
  if (!hostname.endsWith(PROD_SUFFIX)) return undefined;
  const label = hostname.slice(0, -PROD_SUFFIX.length);
  return label.length > 0 && PROD_LABEL.test(label) ? label : undefined;
}

/**
 * Validate an API base. Never throws: every `URLPattern` and `URL` operation is
 * treated as capable of throwing, even where the current runtime does not.
 *
 * `isLocalDev` must come from build-time configuration, never from a request
 * header (`Host`), the page `location`, or a query parameter.
 */
export function validateApiBaseWithPattern(
  raw: string | null | undefined,
  isLocalDev: boolean,
): ApiBaseValidation {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_INPUT_LENGTH ||
    UNSAFE_INPUT.test(trimmed)
  ) {
    return reject("ERR_API_BASE_INVALID_URL");
  }

  const { prod, dev } = patterns();
  if (prod === undefined || dev === undefined) {
    return reject("ERR_API_BASE_PATTERN_UNAVAILABLE");
  }

  // `new URL()` has no representation for an out-of-range port, so classify the
  // raw port before the parser can fold every failure into INVALID_URL.
  if (hasInvalidRawPort(trimmed)) {
    return reject("ERR_API_BASE_INVALID_PORT");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject("ERR_API_BASE_INVALID_URL");
  }

  // A `//`-prefixed path re-reads as protocol-relative for any consumer that
  // later treats the stored base as a URL string.
  if (url.pathname.startsWith("//")) {
    return reject("ERR_API_BASE_INVALID_URL");
  }

  // FQDN spellings widen the host space without helping an API base. Reject
  // both one and two trailing dots explicitly instead of relying on a pattern
  // mismatch.
  if (url.hostname.endsWith(".")) {
    return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
  }

  try {
    const prodMatch = prod.exec(url.href);
    if (prodMatch !== null) {
      // `url.hostname` is already lowercased by the parser; the fold is belt for
      // any future edit that reads a pattern group or raw input instead.
      const sub = subdomainOf(url.hostname)?.toLowerCase();
      if (sub === undefined || sub.startsWith("xn--") || DENIED_SUBS.has(sub)) {
        return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
      }
      // `URLPattern` re-parses `url.href`, but Bun's `URL` and `fetch` parsers
      // are separate. Keep the canonical hostname identity explicit so a future
      // change that matches raw input cannot admit a parser differential.
      if (url.hostname !== prodMatch.hostname.input) {
        return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
      }
      return accept(canonicalBase(url), sub);
    }
    const devMatch = dev.exec(url.href);
    if (isLocalDev && devMatch !== null && DEV_HOSTS.has(url.hostname)) {
      if (url.hostname !== devMatch.hostname.input) {
        return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
      }
      return accept(canonicalBase(url));
    }
  } catch {
    return reject("ERR_API_BASE_INVALID_URL");
  }

  return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
}

/**
 * Join a request path onto a base that already passed validation.
 *
 * `new URL(attackerPath, base)` is the documented escape: `//evil.com` replaces
 * the origin outright, and `"/\\evil.com"` canonicalises to a `//evil.com`
 * path. Callers must use this instead of handing untrusted paths to `new URL`.
 */
export function resolveApiUrl(
  base: string,
  path: string,
  isLocalDev = false,
): ApiUrlResult {
  const validated = validateApiBaseWithPattern(base, isLocalDev);
  if (!validated.ok) return validated;

  if (
    path.length === 0 ||
    path.length > MAX_INPUT_LENGTH ||
    UNSAFE_PATH.test(path) ||
    UNSAFE_PATH_ENCODING.test(path) ||
    !path.startsWith("/") ||
    path.startsWith("//")
  ) {
    return reject("ERR_API_BASE_INVALID_URL");
  }

  let href: string;
  try {
    href = new URL(validated.normalized + path).href;
  } catch {
    return reject("ERR_API_BASE_INVALID_URL");
  }

  // The join must not be able to move the origin, even if a future edit above
  // relaxes the path checks.
  try {
    if (new URL(href).origin !== new URL(validated.normalized).origin) {
      return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
    }
  } catch {
    return reject("ERR_API_BASE_INVALID_URL");
  }

  return { ok: true, href };
}
