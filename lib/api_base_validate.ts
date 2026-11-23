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
 *   1. mode guard, so a typo cannot silently select the development policy,
 *   2. cheap input hygiene — type, raw length, C0 controls, backslash,
 *   3. pattern availability,
 *   4. raw authority port range and leading-zero check, so a bad port returns
 *      `ERR_API_BASE_INVALID_PORT` before `new URL()` can collapse it into a
 *      generic parse error,
 *   5. exactly one `new URL()` parse, the only step that can throw,
 *   6. explicit trailing-dot hostname rejection,
 *   7. percent-encoded separators, dot segments and control bytes in the path,
 *   8. protocol and port policy,
 *   9. `URLPattern` over the canonical serialisation for the origin-wide fields
 *      (credentials, port, path, query, fragment), plus a canonical hostname
 *      identity check,
 *  10. hostname policy — production label/deny-list or development host set.
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
 * alternation (`{localhost|127.0.0.1}`) throws `Invalid input to canonicalize a
 * URL host string`, and an IPv6 hostname literal throws `Name position ...`.
 * A numeric port group is the one exception: it compiles, and the development
 * pattern uses it.
 *
 * Do not gate startup on `URLPattern#hasRegExpGroups`: it is `false` for the
 * production pattern but `true` for the development one (the port group), so a
 * blanket assertion would disable half the validator. Do not pass
 * `{ ignoreCase: true }`: `url.href` is already canonical, and the option also
 * makes pathname matching case-insensitive.
 */

// Bun exposes URLPattern as a global at runtime, but the published globals
// table does not list it and bun-types 1.4.5 does not declare it. The
// documented node:url export is the same constructor (measured 1.4.5), and
// @types/node 23.8+ supplies its type. A static named import would turn a
// missing export into a module-load crash, so read it off the namespace and
// let `buildPatterns` report `ERR_API_BASE_PATTERN_UNAVAILABLE` instead.
import * as nodeUrl from "node:url";

type URLPatternCtor = typeof nodeUrl.URLPattern;

const NODE_URL_PATTERN: URLPatternCtor | null = nodeUrl.URLPattern ?? null;

export type ApiBaseMode = "production" | "development";

/** Rejection codes are stable; callers may switch on them. */
export type ApiBaseRejectCode =
  | "ERR_API_BASE_INVALID_URL"
  | "ERR_API_BASE_INVALID_PORT"
  | "ERR_API_BASE_INVALID_MODE"
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

export interface ApiBaseValidatorOptions {
  /**
   * Override the URLPattern constructor. Defaults to the `node:url` export;
   * `null` forces `ERR_API_BASE_PATTERN_UNAVAILABLE`.
   */
  readonly patternCtor?: URLPatternCtor | null;
}

/** C0 controls, DEL and backslash: `URL` strips the first two and rewrites `\` to `/`. */
const UNSAFE_INPUT = /[\u0000-\u001f\u007f\\]/u;

/** Path characters that would change request semantics if passed through. */
const UNSAFE_PATH = /[\u0000-\u001f\u007f\\#]/u;

/**
 * Dot segments plus percent-encoded separators, dot bytes and C0/DEL bytes.
 * `new URL()` preserves `%2f`, `%5c` and `%00` in `pathname` but normalises
 * `%2e%2e` away, so callers check both the parsed pathname and the raw path.
 */
const UNSAFE_PATH_ENCODING =
  /(?:^|\/)\.{1,2}(?:\/|$)|%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu;

/** Path portion of the raw input, without authority, query or fragment. */
const RAW_PATH = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/iu;

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

function isMode(value: unknown): value is ApiBaseMode {
  return value === "production" || value === "development";
}

function rawPathOf(raw: string): string {
  return RAW_PATH.exec(raw)?.[1] ?? "";
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

type URLPatternInstance = InstanceType<URLPatternCtor>;

interface Patterns {
  readonly production: URLPatternInstance | undefined;
  readonly development: URLPatternInstance | undefined;
}

function buildPatterns(
  policy: ApiBasePolicy,
  PatternCtor: URLPatternCtor | null,
): Patterns {
  if (PatternCtor === null) {
    return { production: undefined, development: undefined };
  }
  try {
    return {
      production: new PatternCtor({
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
      development: new PatternCtor({
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

/** Dot-separated hostname labels; a pattern metacharacter would widen the match. */
const SUFFIX_LABELS = /^(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

const PROTOCOL_SHAPE = /^[a-z][a-z0-9+.-]*:$/u;
const LABEL_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function assertProtocols(protocols: unknown, name: string): void {
  if (!Array.isArray(protocols) || protocols.length === 0) {
    throw new Error(`${name} must be a non-empty array of URL protocols`);
  }
  for (const protocol of protocols) {
    if (typeof protocol !== "string" || !PROTOCOL_SHAPE.test(protocol)) {
      throw new Error(
        `${name} entries must be lower-case protocol strings including the colon`,
      );
    }
  }
}

function assertLabelSet(entries: unknown, name: string): void {
  if (!(entries instanceof Set)) {
    throw new Error(`${name} must be a Set of lower-case hostname labels`);
  }
  // A string is iterable; without the Set check it becomes a character set.
  for (const entry of entries) {
    if (typeof entry !== "string" || !LABEL_SHAPE.test(entry)) {
      throw new Error(
        `${name} entries must be lower-case single hostname labels`,
      );
    }
  }
}

function assertHostSet(entries: unknown, name: string): void {
  if (!(entries instanceof Set)) {
    throw new Error(`${name} must be a Set of canonical URL hostnames`);
  }
  for (const host of entries) {
    if (typeof host !== "string" || host.length === 0) {
      throw new Error(`${name} entries must be non-empty strings`);
    }
    // `URL.hostname` lower-cases, keeps IPv6 brackets and strips default ports,
    // so a round trip catches every non-canonical spelling the host set could
    // otherwise never match.
    if (
      host !== host.toLowerCase() ||
      host.includes("*") ||
      host.endsWith(".")
    ) {
      throw new Error(
        `${name} entries must be lower-case canonical URL hostnames`,
      );
    }
    let canonical: string;
    try {
      canonical = new URL(`http://${host}`).hostname;
    } catch {
      throw new Error(`${name} entries must be canonical URL hostnames`);
    }
    if (canonical !== host) {
      throw new Error(`${name} entries must be canonical URL hostnames`);
    }
  }
}

function assertPolicy(policy: ApiBasePolicy): void {
  // The signature is TypeScript-only; a JavaScript caller can still pass null
  // or a partial object. Check the container shapes first so the error names
  // the bad field instead of surfacing as a `TypeError` on a property read.
  if (policy === null || typeof policy !== "object") {
    throw new Error("policy must be an object");
  }
  const { production, development } = policy;
  if (production === null || typeof production !== "object") {
    throw new Error("production policy must be an object");
  }
  if (development === null || typeof development !== "object") {
    throw new Error("development policy must be an object");
  }
  if (typeof production.suffix !== "string") {
    throw new Error("production.suffix must be a string");
  }

  assertProtocols(policy.production.protocols, "production.protocols");
  assertProtocols(policy.development.protocols, "development.protocols");
  assertLabelSet(
    policy.production.deniedSubdomains,
    "production.deniedSubdomains",
  );
  assertHostSet(policy.development.hosts, "development.hosts");
  if (!policy.production.suffix.startsWith(".")) {
    throw new Error("production.suffix must start with a dot");
  }
  if (!SUFFIX_LABELS.test(policy.production.suffix)) {
    throw new Error(
      "production.suffix must be lower-case dot-separated hostname labels",
    );
  }
  // Both port rules are literals; a typo from a JavaScript caller must fail
  // here rather than fall through to the permissive branch in `portAllowed`.
  if (policy.production.port !== "default-only") {
    throw new Error('production.port must be "default-only"');
  }
  if (policy.development.port !== "any-valid") {
    throw new Error('development.port must be "any-valid"');
  }
  // A non-RegExp label would silently compile to `/(?:)/` and accept anything.
  if (!(policy.production.label instanceof RegExp)) {
    throw new Error("production.label must be a RegExp");
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
  options: ApiBaseValidatorOptions = {},
): ApiBaseValidator {
  assertPolicy(policy);
  // `options` is typed non-null, but a JavaScript caller may pass null; there
  // is no override to apply, so treat it as the default rather than throwing.
  const configuredPattern = options?.patternCtor;
  const PatternCtor =
    configuredPattern === undefined ? NODE_URL_PATTERN : configuredPattern;
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
    cachedPatterns ??= buildPatterns(rules, PatternCtor);
    return cachedPatterns;
  }

  function validate(
    raw: string | null | undefined,
    mode: ApiBaseMode,
  ): ApiBaseValidation {
    // Fail closed on a mode typo. The permissive development policy must be
    // selected explicitly, never by a string that merely fails `=== "production"`.
    if (!isMode(mode)) {
      return reject("ERR_API_BASE_INVALID_MODE");
    }

    // The length budget applies to the raw input: trimming first would let an
    // oversized, whitespace-padded string consume work before the bound.
    if (typeof raw !== "string" || raw.length > rules.maxInputLength) {
      return reject("ERR_API_BASE_INVALID_URL");
    }
    const trimmed = raw.trim();
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

    // `new URL()` normalises `%2e%2e` away but keeps `%2f`, `%5c` and `%00`,
    // so check the parsed pathname and the raw path. Without this, a prefix
    // such as `/v1%2f..%2fadmin` is stored and later resolved verbatim.
    if (
      UNSAFE_PATH_ENCODING.test(url.pathname) ||
      UNSAFE_PATH_ENCODING.test(rawPathOf(trimmed))
    ) {
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
      typeof path !== "string" ||
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
 * query parameter. Only the boolean `true` selects development: a truthy string,
 * number or object must not enable the loopback policy.
 */
export function validateApiBaseWithPattern(
  raw: string | null | undefined,
  isLocalDev: boolean,
): ApiBaseValidation {
  return defaultValidator.validate(
    raw,
    isLocalDev === true ? "development" : "production",
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
    isLocalDev === true ? "development" : "production",
  );
}
