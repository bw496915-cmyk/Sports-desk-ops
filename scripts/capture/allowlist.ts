/**
 * Read-only allowlist for evidence capture.
 *
 * The capture CLI may only exercise Manager read paths. Mutations are refused in
 * code (not merely by convention) because a live capture run authenticates as a
 * real agent: an off-allowlist call could move money or delete a wager.
 */

export const READ_ONLY_OPS = [
  "getWebLog",
  "getInfoPlayer",
  "getBetTicker",
  "getBetTickerConfig",
  "getPending",
  "getSportsVigSetup",
  "getInfoManager",
  "getCustomerNotes",
] as const;

export type ReadOnlyOp = (typeof READ_ONLY_OPS)[number];

/**
 * Operations the spec declares (or the wire implies) that change state. Kept
 * explicit so a refusal can name the operation instead of "unknown".
 */
export const MUTATION_OPS = [
  "updateByColumn",
  "vigSetupInsert",
  "createPlayer",
  "adjustBalance",
  "deleteWager",
  "deleteSportsVigSetup",
  "updateCustomerNotes",
  "delete-wager",
  "gameAdmin",
] as const;

export type MutationOp = (typeof MUTATION_OPS)[number];

export type AllowlistErrorCode = "mutation" | "unknown-op" | "auth-exchange";

export class AllowlistError extends Error {
  readonly code: AllowlistErrorCode;
  readonly operation: string;

  constructor(code: AllowlistErrorCode, operation: string) {
    super(describeRefusal(code, operation));
    this.name = "AllowlistError";
    this.code = code;
    this.operation = operation;
  }
}

function describeRefusal(code: AllowlistErrorCode, operation: string): string {
  switch (code) {
    case "mutation":
      return `refusing mutation operation "${operation}": evidence capture is read-only (allowlist: ${READ_ONLY_OPS.join(", ")})`;
    case "auth-exchange":
      return `refusing operation "${operation}": authentication exchange is performed by the WebView login, not captured as a read op`;
    case "unknown-op":
      return `refusing operation "${operation}": not in the read-only allowlist (${READ_ONLY_OPS.join(", ")})`;
  }
}

const READ_ONLY_SET: ReadonlySet<string> = new Set(READ_ONLY_OPS);
const MUTATION_SET: ReadonlySet<string> = new Set(MUTATION_OPS);
const ALL_KNOWN_OPS: readonly string[] = [...READ_ONLY_OPS, ...MUTATION_OPS];

/**
 * Normalize a CLI token, spec path or operationId to a bare operation name.
 * Accepts `getWebLog`, `/cloud/api/Manager/getWebLog`, `POST .../getWebLog`,
 * and generated ids such as `postCloudApiManagerGetWebLog`.
 */
export function normalizeOperationName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.includes("/")) {
    const segments = trimmed.split("/").filter((segment) => segment.length > 0);
    const last = segments[segments.length - 1];
    return last === undefined ? "" : last.trim();
  }
  if (READ_ONLY_SET.has(trimmed) || MUTATION_SET.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const known of ALL_KNOWN_OPS) {
    if (lower.endsWith(known.toLowerCase())) return known;
  }
  return trimmed;
}

/** True when the token names an allowlisted read-only operation. */
export function isReadOnlyOp(name: string): name is ReadOnlyOp {
  return READ_ONLY_SET.has(normalizeOperationName(name));
}

/** True when the token names an operation that mutates state. */
export function isMutationOp(name: string): boolean {
  return MUTATION_SET.has(normalizeOperationName(name));
}

/**
 * Assert that `pathOrName` may be captured. Throws `AllowlistError` otherwise —
 * callers map that to exit code 2, never a silent skip.
 */
export function assertReadOnly(pathOrName: string): ReadOnlyOp {
  const name = normalizeOperationName(pathOrName);
  if (isReadOnlyOp(name)) return name;
  if (MUTATION_SET.has(name)) throw new AllowlistError("mutation", name);
  if (name === "authenticateCustomer" || name === "verifySession") {
    throw new AllowlistError("auth-exchange", name);
  }
  throw new AllowlistError("unknown-op", name);
}

/**
 * Parse an `--ops` argument (`all` or a comma list) into allowlisted ops,
 * preserving allowlist order and de-duplicating. Throws on any off-allowlist
 * entry so a request never half-runs.
 */
export function parseOpsArgument(value: string | undefined): ReadOnlyOp[] {
  if (
    value === undefined ||
    value.trim().length === 0 ||
    value.trim() === "all"
  ) {
    return [...READ_ONLY_OPS];
  }
  const requested = new Set<ReadOnlyOp>();
  for (const token of value.split(",")) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    requested.add(assertReadOnly(trimmed));
  }
  if (requested.size === 0) {
    throw new AllowlistError("unknown-op", "<empty --ops list>");
  }
  return READ_ONLY_OPS.filter((op) => requested.has(op));
}

/** Known spec paths for allowlisted operations. */
export function opPath(op: ReadOnlyOp): string {
  return `/cloud/api/Manager/${op}`;
}

/** Spec operationId for an allowlisted operation. */
export function opOperationId(op: ReadOnlyOp): string {
  return `postCloudApiManager${op.charAt(0).toUpperCase()}${op.slice(1)}`;
}

/** Resolve a spec path back to its allowlisted op, or null. */
export function opForPath(path: string): ReadOnlyOp | null {
  const name = normalizeOperationName(path);
  return isReadOnlyOp(name) ? name : null;
}
