/**
 * @file lib/api_base_validate.ts
 * @description Fail-closed validation of a BookDeskOps API base origin.
 *
 * The validator is policy-driven so the hostname, protocol, and port rules can
 * be tested and replaced independently:
 *   - production: allowed protocols, one label under a configured suffix,
 *     default port only;
 *   - development: allowed protocols, an explicit host set, any valid port.
 *
 * Check order is deliberate:
 *   1. cheap input hygiene — type, length, C0 controls, backslash,
 *   2. pattern availability,
 *   3. raw authority port range and leading-zero check, so a bad port returns
 *      `ERR_API_BASE_INVALID_PORT` before `new URL()` can collapse it into a
 *      generic parse error,
 *   4. exactly one `new URL()` parse, the only step that can throw,
 *   5. explicit trailing-dot hostname rejection,
 *   6. protocol and port policy,
 *   7. `URLPattern` over the canonical serialisation for the origin-wide fields
 *      (credentials, port, path, query, fragment), plus a canonical hostname
 *      identity check,
 *   8. hostname policy — production label/deny-list or development host set.
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
 * exception: it works, and the development pattern uses it.
 *
 * Do not gate startup on `URLPattern#hasRegExpGroups` either: it is `false` for
 * these patterns by design (no regexp groups), so asserting it would disable the
 * validator. Do not pass `{ ignoreCase: true }`: `url.href` is already
 * canonical, and the option also makes pathname matching case-insensitive.
 */

export type ApiBaseMode = "production" | "development";

/** Rejection codes are stable; callers may switch on them. */
export type ApiBaseRejectCode =
  | "ERR_API_BASE_INVALID_URL"
  | "ERR_API_BASE_INVALID_PORT"
  | "ERR_API_BASE_ORIGIN_UNTRUSTED"
  | "ERR_API_BASE_PATTERN_UNAVAILABLE";

export interface ApiBasePolicy {
  readonly production: {
    /** `URL.protocol` values including the colon, e.g. `"https:"`. */
    readonly protocols: readonly string[];
    /** Host suffix including the leading dot, e.g. `".bookdeskops.com"`. */
    readonly suffix: string;
    /** Single-label shape. Cloned without `g`/`y` by the factory. */
    readonly label: RegExp;
    readonly deniedSubdomains: ReadonlySet<string>;
    /** Production accepts only the protocol default (omitted by `URL`). */
    readonly port: "default-only";
  };
  readonly development: {
    /** `URL.protocol` values including the colon. */
    readonly protocols: readonly string[];
    /** `URL.hostname` values after canonicalisation, e.g. `"[::1]"`. */
    readonly hosts: ReadonlySet<string>;
    /** Development accepts any canonical port in 1..65535. */
    readonly port: "any-valid";
  };
  readonly maxInputLength: number;
}

/** The production policy for BookDeskOps; replace it for another deployment. */
export const BOOKDESKOPS_API_BASE_POLICY: ApiBasePolicy = {
  production: {
    protocols: ["https:"],
    suffix: ".bookdeskops.com",
    label: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    deniedSubdomains: new Set(["staging"]),
    port: "default-only",
  },
  development: {
    protocols: ["http:", "https:"],
    hosts: new Set(["localhost", "127.0.0.1", "[::1]"]),
    port: "any-valid",
  },
  maxInputLength: 2_048,
};

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

export interface ApiBaseValidator {
  readonly validate: (
    raw: string | null | undefined,
    mode: ApiBaseMode,
  ) => ApiBaseValidation;
  readonly resolve: (
    base: string,
    path: string,
    mode?: ApiBaseMode,
  ) => ApiUrlResult;
}

/** C0 controls, DEL and backslash: `URL` strips the first two and rewrites `\` to `/`. */
const UNSAFE_INPUT = /[\u0000-\u001f\u007f\\]/u;

/** Path characters that would change request semantics if passed through. */
const UNSAFE_PATH = /[\u0000-\u001f\u007f\\#]/u;

/** Dot segments and percent-encoded separators: traversal / prefix escape. */
const UNSAFE_PATH_ENCODING = /(?:^|\/)\.{1,2}(?:\/|$)|%(?:2e|2f|5c)/iu;

/**
 * 1–65535, no leading zero. Measured on Bun 1.4.5: a numeric `port` group is
 * accepted by `URLPattern`, unlike hostname groups, so the development pattern
 * can express the range itself.
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
function normalizeBase(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

function hasInvalidRawPort(raw: string): boolean {
  const match = RAW_AUTHORITY_PORT.exec(raw);
  if (match === null) return false;
  const text = match[1]!;
  // Leading zeros are aliases: `:0443` is `:443`, `:00080` is `:80`.
  if (text.length > 1 && text.startsWith("0")) return true;
  const port = Number(text);
  return !Number.isSafeInteger(port) || port < 1 || port > 65_535;
}

function isCanonicalPort(text: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(text)) return false;
  const port = Number(text);
  return Number.isSafeInteger(port) && port <= 65_535;
}

function protocolAllowed(
  url: URL,
  policy: ApiBasePolicy,
  mode: ApiBaseMode,
): boolean {
  const protocols =
    mode === "production"
      ? policy.production.protocols
      : policy.development.protocols;
  return protocols.includes(url.protocol);
}

function portAllowed(
  url: URL,
  policy: ApiBasePolicy,
  mode: ApiBaseMode,
): boolean {
  const rule =
    mode === "production" ? policy.production.port : policy.development.port;
  if (rule === "default-only") return url.port === "";
  return url.port === "" || isCanonicalPort(url.port);
}

/** Valid lower-case production label directly left of the suffix, or `undefined`. */
function productionSubdomain(
  hostname: string,
  policy: ApiBasePolicy["production"],
  label: RegExp,
): string | undefined {
  if (!hostname.endsWith(policy.suffix)) return undefined;
  const sub = hostname.slice(0, -policy.suffix.length).toLowerCase();
  if (
    sub.length === 0 ||
    !label.test(sub) ||
    sub.startsWith("xn--") ||
    policy.deniedSubdomains.has(sub)
  ) {
    return undefined;
  }
  return sub;
}

interface Patterns {
  readonly production: URLPattern | undefined;
  readonly development: URLPattern | undefined;
}

function buildPatterns(policy: ApiBasePolicy): Patterns {
  try {
    return {
      production: new URLPattern({
        protocol: "*",
        username: "",
        password: "",
        hostname: `:sub${policy.production.suffix}`,
        port: "",
        pathname: "{/*}?",
        search: "",
        hash: "",
      }),
      // Hostname is `*` and checked against the policy host set afterwards; a
      // hostname pattern cannot enumerate localhost / 127.0.0.1 / [::1] on
      // Bun 1.4.5. The port group is safe, and it rejects `:0` and every value
      // above 65535 even if a future edit applies the pattern to raw input.
      development: new URLPattern({
        protocol: "*",
        username: "",
        password: "",
        hostname: "*",
        port: `:port(${DEV_PORT})?`,
        pathname: "{/*}?",
        search: "",
        hash: "",
      }),
    };
  } catch {
    // Older runtime without URLPattern, or an engine-specific pattern failure.
    // One failed pattern disables all of them: a half-initialised pair is how a
    // validator starts accepting things it cannot check.
    return { production: undefined, development: undefined };
  }
}

function assertPolicy(policy: ApiBasePolicy): void {
  if (!policy.production.suffix.startsWith(".")) {
    throw new Error("production.suffix must start with a dot");
  }
  if (
    !Number.isSafeInteger(policy.maxInputLength) ||
    policy.maxInputLength < 1
  ) {
    throw new Error("maxInputLength must be a positive safe integer");
  }
}

/**
 * Build a validator for one policy. The production and development rules stay
 * separate: changing the suffix, loopback hosts, protocols, or port policy does
 * not touch the parsing and canonicalisation steps.
 */
export function createApiBaseValidator(
  policy: ApiBasePolicy = BOOKDESKOPS_API_BASE_POLICY,
): ApiBaseValidator {
  assertPolicy(policy);
  const label = new RegExp(
    policy.production.label.source,
    policy.production.label.flags.replace(/[gy]/gu, ""),
  );
  // Snapshot the policy so later mutation of the caller's arrays or sets cannot
  // change a validator that has already been created.
  const rules: ApiBasePolicy = {
    production: {
      protocols: Object.freeze([...policy.production.protocols]),
      suffix: policy.production.suffix,
      label,
      deniedSubdomains: new Set(policy.production.deniedSubdomains),
      port: policy.production.port,
    },
    development: {
      protocols: Object.freeze([...policy.development.protocols]),
      hosts: new Set(policy.development.hosts),
      port: policy.development.port,
    },
    maxInputLength: policy.maxInputLength,
  };
  let cachedPatterns: Patterns | undefined;

  function patterns(): Patterns {
    cachedPatterns ??= buildPatterns(rules);
    return cachedPatterns;
  }

  function validate(
    raw: string | null | undefined,
    mode: ApiBaseMode,
  ): ApiBaseValidation {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (
      trimmed.length === 0 ||
      trimmed.length > rules.maxInputLength ||
      UNSAFE_INPUT.test(trimmed)
    ) {
      return reject("ERR_API_BASE_INVALID_URL");
    }

    const { production, development } = patterns();
    if (production === undefined || development === undefined) {
      return reject("ERR_API_BASE_PATTERN_UNAVAILABLE");
    }

    // `new URL()` has no representation for an out-of-range port, so classify
    // the raw port before the parser can fold every failure into INVALID_URL.
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

    if (!protocolAllowed(url, rules, mode)) {
      return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
    }
    if (!portAllowed(url, rules, mode)) {
      return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
    }

    try {
      if (mode === "production") {
        const match = production.exec(url.href);
        if (match === null) {
          return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
        }
        // `URLPattern` re-parses `url.href`, but Bun's `URL` and `fetch`
        // parsers are separate. Keep the canonical hostname identity explicit
        // so a future change that matches raw input cannot admit a parser
        // differential.
        if (url.hostname !== match.hostname.input) {
          return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
        }
        const sub = productionSubdomain(url.hostname, rules.production, label);
        if (sub === undefined) {
          return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
        }
        return accept(normalizeBase(url), sub);
      }

      const match = development.exec(url.href);
      if (match === null || !rules.development.hosts.has(url.hostname)) {
        return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
      }
      if (url.hostname !== match.hostname.input) {
        return reject("ERR_API_BASE_ORIGIN_UNTRUSTED");
      }
      return accept(normalizeBase(url));
    } catch {
      return reject("ERR_API_BASE_INVALID_URL");
    }
  }

  function resolve(
    base: string,
    path: string,
    mode: ApiBaseMode = "production",
  ): ApiUrlResult {
    const validated = validate(base, mode);
    if (!validated.ok) return validated;

    if (
      path.length === 0 ||
      path.length > rules.maxInputLength ||
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

  return { validate, resolve };
}

const defaultValidator = createApiBaseValidator(BOOKDESKOPS_API_BASE_POLICY);

/**
 * Validate with the BookDeskOps policy. `isLocalDev` must come from build-time
 * configuration, never from a request header (`Host`), the page `location`, or a
 * query parameter.
 */
export function validateApiBaseWithPattern(
  raw: string | null | undefined,
  isLocalDev: boolean,
): ApiBaseValidation {
  return defaultValidator.validate(
    raw,
    isLocalDev ? "development" : "production",
  );
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
  return defaultValidator.resolve(
    base,
    path,
    isLocalDev ? "development" : "production",
  );
}
