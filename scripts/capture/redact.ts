/**
 * Redaction policy for evidence captures (policy v1).
 *
 * Two rules drive everything here:
 *   1. A capture record stores shapes, hashes and header *names* — never raw
 *      values. So redaction runs before the record is built, and the built
 *      record is scanned again before it can be persisted.
 *   2. Error/log text is data too. `redactError` strips URL userinfo, query
 *      values, bearer/JWT tokens, cookie/authorization headers, emails and
 *      public IPs so a failed live capture cannot leak a credential.
 */

import { isPlainObject, sha256Hex } from "./json.ts";

/** Replacement for an entire sensitive value. */
export const REDACTED = "<redacted>";

/**
 * PII categories. The first five are detectable by pattern; the rest are
 * detected from the field name in a JSON body.
 */
export type PiiKind =
  | "email"
  | "ip"
  | "phone"
  | "jwt"
  | "bearer"
  | "customer-id"
  | "login"
  | "agent-id"
  | "password"
  | "token"
  | "address";

export interface PiiFinding {
  kind: PiiKind;
  count: number;
}

export interface BodyRedactionResult {
  /** The sanitized copy; callers may discard it (records never persist bodies). */
  clean: unknown;
  fieldsRedacted: string[];
  piiRedacted: PiiKind[];
}

export interface HeaderRedactionResult {
  clean: Record<string, string>;
  fieldsRedacted: string[];
}

/** Stable placeholder for a whole sensitive field, e.g. `<redacted:agent-id>`. */
export function placeholderFor(kind: PiiKind): string {
  return `<redacted:${kind}>`;
}

/**
 * Optional stable placeholder that keeps cross-record linkage. Only use when
 * the value is high-entropy: hashing a customer ID is reversible by brute force.
 */
export function hashedPlaceholderFor(kind: PiiKind, value: string): string {
  return `<redacted:${kind}:${sha256Hex(value).slice(0, 12)}>`;
}

// ---------------------------------------------------------------------------
// Field-name classification
// ---------------------------------------------------------------------------

interface KeyRule {
  readonly kind: PiiKind;
  readonly pattern: RegExp;
}

const PII_KEY_RULES: readonly KeyRule[] = [
  {
    kind: "customer-id",
    pattern:
      /^(?:customer_?id|padded_?customer_?id|acct|account_?id|customer_?number|telegram_?id)$/i,
  },
  {
    kind: "login",
    pattern:
      /^(?:login|customer_?login|user_?name|username|user_?id|userid|bettor|player_?id|name_?first|name_?last|name_?mi|first_?name|last_?name)$/i,
  },
  {
    kind: "agent-id",
    pattern:
      /^(?:agent_?id|agent_?owner|agent_?login|owner_?id|master_?agent)$/i,
  },
  {
    kind: "ip",
    pattern: /^(?:ip|ip_?address|client_?ip|remote_?addr|remote_?ip)$/i,
  },
  {
    kind: "email",
    pattern: /^(?:email|e_?mail|email_?address)$/i,
  },
  {
    kind: "password",
    pattern: /^(?:password|passwordt|passwd|pass_?code|pwd|secret)$/i,
  },
  {
    kind: "token",
    pattern:
      /^(?:token|access_?token|refresh_?token|jwt|bearer|authorization|session_?id|sid|api_?key|csrf(?:_?token)?|xsrf(?:_?token)?)$/i,
  },
  {
    kind: "phone",
    pattern:
      /^(?:phone|telephone|mobile|cell|phone_?number|sms_?phone_?number|home_?phone|business_?phone|fax)$/i,
  },
  {
    kind: "address",
    pattern:
      /^(?:address|street|street_?address|city|state|zip|zip_?code|postal_?code)$/i,
  },
];

/** Classify a JSON body key as PII, or return null for an ordinary key. */
export function classifyPiiKey(key: string): PiiKind | null {
  for (const rule of PII_KEY_RULES) {
    if (rule.pattern.test(key)) return rule.kind;
  }
  return null;
}

/** True when a field name must never have its value persisted. */
export function isSensitiveKey(key: string): boolean {
  return classifyPiiKey(key) !== null;
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PHONE_RE = /(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const PRIVATE_IPV4_FIRST_OCTETS = new Set([0, 10, 127, 255]);

function isPublicIpv4(candidate: string): boolean {
  const octets = candidate.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4) return false;
  for (const octet of octets) {
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
  }
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  if (PRIVATE_IPV4_FIRST_OCTETS.has(first)) return false;
  if (first === 192 && second === 168) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 169 && second === 254) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  return true;
}

function isIpv4Candidate(candidate: string): boolean {
  const octets = candidate.split(".");
  if (octets.length !== 4) return false;
  return octets.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number.parseInt(part, 10);
    return value >= 0 && value <= 255;
  });
}

/**
 * Find detectable PII in arbitrary text. Returns one entry per category.
 * Private/loopback IPv4 addresses are not treated as PII (they identify a
 * machine, not a person, and local test servers legitimately use them).
 */
export function scanPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  let rest = text;

  const bearerCount = [...rest.matchAll(BEARER_RE)].length;
  if (bearerCount > 0) {
    findings.push({ kind: "bearer", count: bearerCount });
    rest = rest.replace(BEARER_RE, " ");
  }
  const jwtCount = [...rest.matchAll(JWT_RE)].length;
  if (jwtCount > 0) {
    findings.push({ kind: "jwt", count: jwtCount });
    rest = rest.replace(JWT_RE, " ");
  }
  const emailCount = [...rest.matchAll(EMAIL_RE)].length;
  if (emailCount > 0) {
    findings.push({ kind: "email", count: emailCount });
    rest = rest.replace(EMAIL_RE, " ");
  }
  let ipCount = 0;
  for (const match of rest.matchAll(IPV4_RE)) {
    if (isIpv4Candidate(match[0]) && isPublicIpv4(match[0])) ipCount += 1;
  }
  if (ipCount > 0) findings.push({ kind: "ip", count: ipCount });
  rest = rest.replace(IPV4_RE, " ");
  const phoneCount = [...rest.matchAll(PHONE_RE)].length;
  if (phoneCount > 0) findings.push({ kind: "phone", count: phoneCount });

  return findings.sort((left, right) => left.kind.localeCompare(right.kind));
}

/** Redact detectable PII tokens inside free text. */
export function redactString(text: string): string {
  let out = text;
  out = out.replace(BEARER_RE, placeholderFor("bearer"));
  out = out.replace(JWT_RE, placeholderFor("jwt"));
  out = out.replace(EMAIL_RE, placeholderFor("email"));
  out = out.replace(IPV4_RE, (match) =>
    isIpv4Candidate(match) && isPublicIpv4(match)
      ? placeholderFor("ip")
      : match,
  );
  out = out.replace(PHONE_RE, placeholderFor("phone"));
  return out;
}

/** True when the value (any JSON value, walked recursively) contains PII. */
export function hasPii(value: unknown): boolean {
  return findPiiInValue(value).length > 0;
}

/** Find PII inside every string of a JSON value; numbers are not scanned. */
export function findPiiInValue(value: unknown): PiiFinding[] {
  const totals = new Map<PiiKind, number>();
  walk(value, (text) => {
    for (const finding of scanPii(text)) {
      totals.set(finding.kind, (totals.get(finding.kind) ?? 0) + finding.count);
    }
  });
  return [...totals.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function walk(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) walk(child, visit);
  }
}

export class PiiLeakError extends Error {
  readonly findings: PiiFinding[];

  constructor(label: string, findings: PiiFinding[]) {
    const detail = findings
      .map((finding) => `${finding.kind} x${finding.count}`)
      .join(", ");
    super(`${label} contains unredacted PII (${detail})`);
    this.name = "PiiLeakError";
    this.findings = findings;
  }
}

/** Refuse to persist anything that still contains detectable PII. */
export function assertNoPii(value: unknown, label: string): void {
  const findings = findPiiInValue(value);
  if (findings.length > 0) throw new PiiLeakError(label, findings);
}

// ---------------------------------------------------------------------------
// Header redaction
// ---------------------------------------------------------------------------

const DENY_HEADER_RE =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|csrf-token|x-xsrf-token|xsrf-token|x-auth-token|auth-token|x-api-key|api-key|x-session-id|session|sessionid|jwt|bearer|token|password)$/i;

const SAFE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "host",
  "origin",
  "pragma",
  "user-agent",
  "x-requested-with",
]);

/**
 * Redact request/response headers for persistence.
 *
 * - Deny-listed names keep their name with `<redacted>` as the value.
 * - `referer` keeps origin+path only (query strings can carry session tokens).
 * - Allow-listed names keep their value, sanitized for PII tokens.
 * - Anything else is not trusted: value becomes `<redacted>`.
 */
export function redactHeaders(
  headers: Record<string, string>,
): HeaderRedactionResult {
  const clean: Record<string, string> = {};
  const fields: string[] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (name.length === 0) continue;
    const value = typeof rawValue === "string" ? rawValue : String(rawValue);
    if (DENY_HEADER_RE.test(name)) {
      clean[name] = REDACTED;
      fields.push(name);
      continue;
    }
    if (name === "referer") {
      clean[name] = sanitizeReferer(value);
      fields.push(name);
      continue;
    }
    if (!SAFE_HEADERS.has(name)) {
      clean[name] = REDACTED;
      fields.push(name);
      continue;
    }
    const sanitized = redactString(value);
    if (sanitized !== value) fields.push(name);
    clean[name] = sanitized;
  }
  return { clean, fieldsRedacted: [...new Set(fields)].sort() };
}

/** Keep only scheme://host/path from a referer; never the query or fragment. */
export function sanitizeReferer(value: string): string {
  try {
    const url = new URL(value);
    const userinfo =
      url.username.length > 0 || url.password.length > 0 ? `${REDACTED}@` : "";
    return `${url.protocol}//${userinfo}${url.host}${url.pathname}`;
  } catch {
    return REDACTED;
  }
}

// ---------------------------------------------------------------------------
// Body redaction
// ---------------------------------------------------------------------------

/**
 * Redact PII from a parsed JSON body.
 *
 * Sensitive keys become `<redacted:kind>` placeholders (values discarded);
 * other string values are scanned for emails/IPs/phones/tokens. The result is
 * for diagnostics only — capture records persist the skeleton, not this body.
 */
export function redactJson(value: unknown): BodyRedactionResult {
  const fields = new Set<string>();
  const kinds = new Set<PiiKind>();

  const redactNode = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((item, index) => redactNode(item, `${path}[${index}]`));
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node).sort()) {
        const kind = classifyPiiKey(key);
        const childPath = `${path}.${key}`;
        if (kind !== null) {
          fields.add(childPath);
          kinds.add(kind);
          out[key] = placeholderFor(kind);
          continue;
        }
        out[key] = redactNode(node[key], childPath);
      }
      return out;
    }
    if (typeof node === "string") {
      const findings = scanPii(node);
      if (findings.length > 0) {
        fields.add(path);
        for (const finding of findings) kinds.add(finding.kind);
        return redactString(node);
      }
      return node;
    }
    return node;
  };

  const clean = redactNode(value, "body");
  return {
    clean,
    fieldsRedacted: [...fields].sort(),
    piiRedacted: [...kinds].sort(),
  };
}

// ---------------------------------------------------------------------------
// Log / error redaction
// ---------------------------------------------------------------------------

/** Scheme+host+path of a URL, with userinfo and query removed. */
export function redactUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    const userinfo =
      url.username.length > 0 || url.password.length > 0 ? `${REDACTED}@` : "";
    const path = url.pathname.replace(/\d{2,}/g, ":id");
    return `${url.protocol}//${userinfo}${url.host}${path}`;
  } catch {
    return REDACTED;
  }
}

/**
 * Turn any thrown value into a single redacted line. Never includes a stack
 * trace: stacks carry file paths and local variable text that may hold secrets.
 */
export function redactError(
  error: unknown,
  extraSecrets: readonly string[] = [],
): string {
  let message: string;
  if (error instanceof Error) {
    message = `${error.name}: ${error.message}`;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = "unknown error";
  }

  let out = message;
  for (const secret of extraSecrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join(REDACTED);
  }
  // URL userinfo first: an email-shaped `user:pass@host` must keep its host and
  // must not be mistaken for an email address by the pattern pass below.
  out = out.replace(/\/\/[^/@\s]+@/g, `//${REDACTED}@`);
  out = redactString(out);
  out = out.replace(/([?&][^=&\s#]+)=([^&\s#]*)/g, (_match, key: string) => {
    return `${key}=${REDACTED}`;
  });
  out = out.replace(
    /\b(authorization|cookie|set-cookie|x-api-key|proxy-authorization)\b\s*[:=]\s*[^\n;]+/gi,
    (_match, name: string) => `${name}: ${REDACTED}`,
  );
  return out;
}
