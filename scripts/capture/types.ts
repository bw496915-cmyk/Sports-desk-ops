/**
 * Capture record schema v1 + the transport/allowlist types the capture core
 * shares with the CLI and tests.
 *
 * The record is deliberately value-free: request/response bodies are reduced to
 * a sha256 and a schema skeleton, so a committed capture store cannot leak
 * credentials, customer IDs, IPs or emails. `redact.ts` owns the redaction
 * policy; this module only describes the shape that gets persisted.
 */

import type { PiiKind } from "./redact.ts";

export const CAPTURE_SCHEMA_VERSION = 1;
export const REDACTION_POLICY_VERSION = 1;
export const CAPTURE_STORE_NAME = "evidence-captures";

export type CaptureMode = "live" | "mock";

/** Only read-shaped verbs are ever sent by the capture core. */
export type HttpMethod = "GET" | "POST";

/** Evidence tiers used by the docs ledger; captures can only upgrade to A. */
export type EvidenceTier = "A" | "B" | "C" | "D" | "E";

// ---------------------------------------------------------------------------
// Schema skeletons (value-free shape inference, see schema.ts)
// ---------------------------------------------------------------------------

export type SkeletonScalarType =
  "string" | "number" | "boolean" | "null" | "unknown";

export interface SkeletonObject {
  type: "object";
  nullable: boolean;
  fields: Record<string, Skeleton>;
  truncated?: boolean;
}

export interface SkeletonArray {
  type: "array";
  nullable: boolean;
  items: Skeleton | null;
  truncated?: boolean;
}

export interface SkeletonScalar {
  type: SkeletonScalarType;
  nullable: boolean;
  /**
   * Optional low-cardinality literal values that are safe to publish (short
   * token-like scalars only; never PII, timestamps, or IDs).
   */
  enumCandidates?: string[];
  truncated?: boolean;
}

export type Skeleton = SkeletonObject | SkeletonArray | SkeletonScalar;

// ---------------------------------------------------------------------------
// Capture record v1
// ---------------------------------------------------------------------------

export interface OperationRef {
  /** Spec path, e.g. `/cloud/api/Manager/getWebLog`. */
  path: string;
  /** Upper-case wire method. */
  method: HttpMethod;
  operationId?: string;
}

export interface CapturedRequest {
  /** Redacted absolute URL (never contains credentials or query secrets). */
  url: string;
  method: HttpMethod;
  /** Header names with any sensitive value replaced by `<redacted>`. */
  headers: Record<string, string>;
  contentType: string;
  /** sha256 over the exact serialized request body (empty-body hash if none). */
  bodySha256: string;
  bodySkeleton: Skeleton | null;
}

export interface CapturedResponse {
  status: number;
  contentType: string;
  /** sha256 over the exact response bytes. */
  bodySha256: string;
  bodySkeleton: Skeleton;
  bytes: number;
}

export interface RedactionReport {
  policyVersion: typeof REDACTION_POLICY_VERSION;
  /** True only when the serialized record itself contains no detectable PII. */
  clean: boolean;
  /** Field paths whose values were redacted, e.g. `request.body.agentID`. */
  fieldsRedacted: string[];
  /** PII categories that were found and redacted. */
  piiRedacted: PiiKind[];
}

// ---------------------------------------------------------------------------
// Evidence axes (tier inputs)
// ---------------------------------------------------------------------------

/** Axis 1: how the captured bytes were observed. */
export type CaptureObservation = "cdp" | "webkit" | "har" | "code" | "authored";

/**
 * Axis 2: what the response body proves. `"populated-shell"` is the server-rendered
 * layout chrome plus metadata (`data-field="version"`, `data-field="domain-me"`) while the
 * dynamic containers are still empty: routing is evidenced, the data is not.
 */
export type CaptureBodyVerdict =
  | "populated"
  | "populated-shell"
  | "empty-envelope"
  | "template"
  | "error-body"
  | "empty-500"
  | "none";

/** Axis 3: how specific the recorded request was. */
export type CaptureRequestVerdict =
  "exact" | "minimal" | "sentinel" | "synthetic" | "mismatched";

/** Axis 5: read, write, or unknown. */
export type CaptureMutationVerdict =
  "read" | "read-inferred" | "write" | "unknown";

/** Axis 4: client state that conditioned the response. */
export type CaptureViewMode = "desktop" | "mobile" | "unknown";

export type CaptureWafVerdict = "cloudflare" | "none" | "unknown";

export interface CaptureProvenanceState {
  viewMode?: CaptureViewMode | undefined;
  sessionStorageCleared?: boolean | undefined;
  betTickerParam?: boolean | undefined;
  /** DOM-extracted version marker, e.g. `"1.0.280"` from `data-field="version"`. */
  domVersion?: string | undefined;
  /** DOM-extracted origin marker, e.g. `"www.fantasy402.com"` from `data-field="domain-me"`. */
  domOrigin?: string | undefined;
  /** True when `window.__CF$cv$params` or `/cdn-cgi/` challenge scripts are present in the DOM. */
  challengePresent?: boolean | undefined;
}

/**
 * Client-state + observation provenance. Every axis is optional and normalized at the
 * record boundary (`buildCaptureRecord`); missing means "not established", never "not applicable".
 */
export interface CaptureProvenance {
  /** Host only; never a full URL with credentials or query. */
  portalHost: string;
  /** `"env"` when the run honored HTTP(S)_PROXY/NO_PROXY, else `"none"`. */
  proxy: "env" | "none";
  auth: "cookie" | "none";
  bunVersion: string;
  /** Runtime origin extracted from the DOM (`[data-field="domain-me"]`), for comparison against `portalHost`. */
  origin?: string | undefined;
  /** Axis 1: how the bytes were observed. Safe default `"authored"` (no observation). */
  observation?: CaptureObservation | undefined;
  /** Axis 2: what the response body proves. Safe default `"none"` (no body verdict). */
  body?: CaptureBodyVerdict | undefined;
  /** Axis 3: how specific the recorded request was. */
  request?: CaptureRequestVerdict | undefined;
  /** Axis 5: read/write/unknown. Safe default `"unknown"`. */
  mutation?: CaptureMutationVerdict | undefined;
  /** Axis 4: client state that conditioned the response. */
  state?: CaptureProvenanceState | undefined;
  /** WAF in front of the portal (edge), distinct from origin errors. */
  waf?: CaptureWafVerdict | undefined;
  /** Cloudflare Ray ID from `Cf-Ray` response header or `__CF$cv$params.r`. */
  cfRay?: string | undefined;
  /** Carried from existing records, unchanged. */
  prefix?: string | undefined;
  backend?: "webkit" | "chrome" | undefined;
  headersObserved?: boolean | undefined;
}

export interface CaptureRecord {
  schemaVersion: typeof CAPTURE_SCHEMA_VERSION;
  mode: CaptureMode;
  /** ISO-8601 UTC timestamp. */
  capturedAt: string;
  operation: OperationRef;
  request: CapturedRequest;
  response: CapturedResponse | null;
  redaction: RedactionReport;
  provenance: CaptureProvenance;
  /** How many wire samples this record summarizes (>=1). */
  samples: number;
}

// ---------------------------------------------------------------------------
// Capture store manifest
// ---------------------------------------------------------------------------

export interface ManifestCaptureEntry {
  /** POSIX-style path relative to the store root: `<date>/<slug>.<method>.json`. */
  file: string;
  mode: CaptureMode;
  capturedAt: string;
  operation: OperationRef;
  /** sha256 of the canonical capture record JSON. */
  captureHash: string;
  requestBodySha256: string;
  responseStatus: number | null;
  responseBodySha256: string | null;
  responseBytes: number | null;
  redaction: {
    policyVersion: typeof REDACTION_POLICY_VERSION;
    clean: boolean;
    fieldsRedacted: number;
    piiRedacted: number;
  };
  provenance: CaptureProvenance;
  samples: number;
  /** Projection from provenance axes (`deriveTier`); not stored on the capture record. */
  derivedTier?: string;
  /** Human/machine-auditable reason from `deriveTierWithReason`. */
  derivedTierReason?: string;
  /** When Cloudflare challenge/clearance bound a 2xx (`captureRecipeFingerprint`). */
  captureRecipeSha256?: string;
}

export interface CaptureManifest {
  schemaVersion: typeof CAPTURE_SCHEMA_VERSION;
  store: typeof CAPTURE_STORE_NAME;
  /** Deterministic for mock runs; wall clock for live runs. */
  generatedAt: string;
  policyVersion: typeof REDACTION_POLICY_VERSION;
  counts: {
    total: number;
    live: number;
    mock: number;
    /**
     * Any HTTP response at all (`responseStatus !== null`), including error and
     * empty-body responses. Kept for backward compatibility and unchanged in
     * meaning; `withSuccessResponse` is the strict count.
     */
    withResponse: number;
    /** No HTTP response was ever observed (`responseStatus === null`). */
    withoutResponse: number;
    /** A response arrived with a 2xx `responseStatus`. */
    withSuccessResponse: number;
    /**
     * A response arrived with a non-2xx `responseStatus` (e.g. 500). Success
     * and error partition `withResponse`.
     */
    withErrorResponse: number;
    /**
     * A response arrived and the recorded body was empty (`responseBytes === 0`).
     * Body content is never persisted (only its sha256, skeleton and byte
     * count), so emptiness is byte-count based. This is an axis independent of
     * success/error: an empty 200 counts in both `withSuccessResponse` and here.
     */
    emptyResponse: number;
    clean: number;
    operations: string[];
  };
  captures: ManifestCaptureEntry[];
}

// ---------------------------------------------------------------------------
// Transport boundary (live = Bun.FetchSession, mock = fixtures)
// ---------------------------------------------------------------------------

/** Environment snapshot; injected in tests so process.env is not relied on. */
export type Env = Record<string, string | undefined>;

export interface RawHttpRequest {
  /** Absolute URL. May contain a query string for GET requests. */
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string | null;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Only read-only requests may opt into retries. */
  retryable?: boolean;
  /** `true` forces a direct (non-proxied) request, e.g. loopback probes. */
  direct?: boolean;
}

export interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Lower-cased, parameter-stripped content type ("" when absent). */
  contentType: string;
  bytes: Uint8Array;
}

/** Injectable boundary: the CLI never depends on a concrete network stack. */
export interface HttpTransport {
  readonly kind: CaptureMode;
  fetch(request: RawHttpRequest): Promise<RawHttpResponse>;
  close?(): Promise<void> | void;
}
