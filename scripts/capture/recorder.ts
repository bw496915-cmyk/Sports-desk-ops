/**
 * Capture record builder + on-disk capture store.
 *
 * Store layout (what `scripts/apply_captures.ts` and the docs tooling read):
 *
 *   <root>/<YYYY-MM-DD>/<slug>.<method>.json   one capture record (v1)
 *   <root>/manifest.json                       index with per-record sha256
 *
 * Every write is atomic (temp file + rename) so a crashed capture never leaves
 * a half-written record that a later reader would trust. The record hash is
 * computed over canonical JSON, making `capture:<date>:<sha256>` ledger
 * evidence pointers stable and idempotent.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  encodeUtf8,
  isPlainObject,
  sha256Hex,
  tryParseJson,
} from "./json.ts";
import {
  assertNoPii,
  redactHeaders,
  redactJson,
  type PiiKind,
} from "./redact.ts";
import { inferSkeletonFromBytes } from "./schema.ts";
import {
  CAPTURE_SCHEMA_VERSION,
  CAPTURE_STORE_NAME,
  REDACTION_POLICY_VERSION,
} from "./types.ts";
import type {
  CaptureManifest,
  CaptureMode,
  CaptureProvenance,
  CaptureRecord,
  CapturedRequest,
  CapturedResponse,
  HttpMethod,
  ManifestCaptureEntry,
  OperationRef,
  RedactionReport,
  Skeleton,
} from "./types.ts";

export const MANIFEST_FILE = "manifest.json";

export interface RecordRequestInput {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  contentType: string;
  body: string | null;
}

export interface RecordResponseInput {
  status: number;
  headers: Record<string, string>;
  contentType: string;
  bytes: Uint8Array;
}

export interface BuildRecordInput {
  mode: CaptureMode;
  capturedAt: string;
  operation: OperationRef;
  request: RecordRequestInput;
  response: RecordResponseInput | null;
  provenance: CaptureProvenance;
  samples?: number;
}

/** Normalize/validate an ISO timestamp to canonical UTC form. */
export function normalizeCapturedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`capturedAt is not a valid ISO date: ${value}`);
  }
  return date.toISOString();
}

/**
 * Build a value-free capture record, or throw `PiiLeakError` if the serialized
 * record would still contain PII. Bodies are hashed and skeletonized; only the
 * redacted header map survives verbatim.
 */
export function buildCaptureRecord(input: BuildRecordInput): CaptureRecord {
  const capturedAt = normalizeCapturedAt(input.capturedAt);
  const samples = input.samples ?? 1;
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error("samples must be a positive integer");
  }

  const headerRedaction = redactHeaders(input.request.headers);
  const requestBodyRedaction = collectBodyRedaction(input);
  const responseBodyRedaction = collectResponseRedaction(input.response);
  const fieldsRedacted = [
    ...new Set([
      ...headerRedaction.fieldsRedacted.map(
        (name) => `request.headers.${name}`,
      ),
      ...requestBodyRedaction.fieldsRedacted.map((path) => `request.${path}`),
      ...responseBodyRedaction.fieldsRedacted.map((path) => `response.${path}`),
    ]),
  ].sort();
  const piiRedacted = [
    ...new Set<PiiKind>([
      ...requestBodyRedaction.piiRedacted,
      ...responseBodyRedaction.piiRedacted,
    ]),
  ].sort();

  const requestBodyBytes =
    input.request.body === null ? null : encodeUtf8(input.request.body);
  const requestCapture: CapturedRequest = {
    url: input.request.url,
    method: input.request.method,
    headers: headerRedaction.clean,
    contentType: input.request.contentType,
    bodySha256: sha256Hex(requestBodyBytes ?? new Uint8Array(0)),
    bodySkeleton:
      requestBodyBytes === null
        ? null
        : inferSkeletonFromBytes(requestBodyBytes, input.request.contentType),
  };

  let responseCapture: CapturedResponse | null = null;
  if (input.response !== null) {
    responseCapture = {
      status: input.response.status,
      contentType: input.response.contentType,
      bodySha256: sha256Hex(input.response.bytes),
      bodySkeleton: inferSkeletonFromBytes(
        input.response.bytes,
        input.response.contentType,
      ),
      bytes: input.response.bytes.length,
    };
  }

  const report: RedactionReport = {
    policyVersion: REDACTION_POLICY_VERSION,
    clean: true,
    fieldsRedacted,
    piiRedacted,
  };

  const record: CaptureRecord = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    mode: input.mode,
    capturedAt,
    operation: { ...input.operation },
    request: requestCapture,
    response: responseCapture,
    redaction: report,
    provenance: { ...input.provenance },
    samples,
  };

  // A redaction failure must block persistence, not be recorded as a warning.
  assertNoPii(record, "capture record");
  return record;
}

interface BodyRedactionContribution {
  fieldsRedacted: string[];
  piiRedacted: PiiKind[];
}

function collectBodyRedaction(
  input: BuildRecordInput,
): BodyRedactionContribution {
  const body = input.request.body;
  if (body === null || body.length === 0) {
    return { fieldsRedacted: [], piiRedacted: [] };
  }
  const contentType = input.request.contentType.toLowerCase();
  const parsed = parseBodyForRedaction(body, contentType);
  if (parsed === undefined) return { fieldsRedacted: [], piiRedacted: [] };
  const result = redactJson(parsed);
  return {
    fieldsRedacted: result.fieldsRedacted,
    piiRedacted: result.piiRedacted,
  };
}

function collectResponseRedaction(
  response: RecordResponseInput | null,
): BodyRedactionContribution {
  if (response === null || response.bytes.length === 0) {
    return { fieldsRedacted: [], piiRedacted: [] };
  }
  if (!response.contentType.includes("json")) {
    return { fieldsRedacted: [], piiRedacted: [] };
  }
  const parsed = tryParseJson(new TextDecoder().decode(response.bytes));
  if (parsed === undefined) return { fieldsRedacted: [], piiRedacted: [] };
  const result = redactJson(parsed);
  return {
    fieldsRedacted: result.fieldsRedacted,
    piiRedacted: result.piiRedacted,
  };
}

function parseBodyForRedaction(body: string, contentType: string): unknown {
  if (contentType.includes("json")) return tryParseJson(body);
  if (contentType.includes("x-www-form-urlencoded")) {
    const params = new URLSearchParams(body);
    const fields: Record<string, string> = {};
    for (const [key, value] of params) fields[key] = value;
    return fields;
  }
  return undefined;
}

/** Canonical sha256 of a capture record (stable across re-serialization). */
export function captureHash(record: CaptureRecord): string {
  return sha256Hex(canonicalJson(record));
}

/** `<slug>.<method>.json` where slug is the last path segment. */
export function captureFileName(operation: OperationRef): string {
  const segments = operation.path.split("/").filter((part) => part.length > 0);
  const last = segments[segments.length - 1] ?? "operation";
  const slug = last.replace(/[^A-Za-z0-9._-]/g, "-") || "operation";
  return `${slug}.${operation.method.toLowerCase()}.json`;
}

/** UTC date directory derived from `capturedAt`. */
export function captureDateDir(capturedAt: string): string {
  return normalizeCapturedAt(capturedAt).slice(0, 10);
}

/** POSIX relative path for a record inside the store root. */
export function captureRelativePath(record: CaptureRecord): string {
  return `${captureDateDir(record.capturedAt)}/${captureFileName(record.operation)}`;
}

export function manifestEntryFor(
  record: CaptureRecord,
  file: string,
): ManifestCaptureEntry {
  return {
    file,
    mode: record.mode,
    capturedAt: record.capturedAt,
    operation: { ...record.operation },
    captureHash: captureHash(record),
    requestBodySha256: record.request.bodySha256,
    responseStatus: record.response?.status ?? null,
    responseBodySha256: record.response?.bodySha256 ?? null,
    responseBytes: record.response?.bytes ?? null,
    redaction: {
      policyVersion: record.redaction.policyVersion,
      clean: record.redaction.clean,
      fieldsRedacted: record.redaction.fieldsRedacted.length,
      piiRedacted: record.redaction.piiRedacted.length,
    },
    provenance: { ...record.provenance },
    samples: record.samples,
  };
}

/** True when a manifest entry recorded a 2xx HTTP response. */
export function isSuccessResponseStatus(status: number): boolean {
  return status >= 200 && status <= 299;
}

/** Response accounting split out for the manifest `counts` block. */
export interface ResponseAccounting {
  /** Any HTTP response; `withSuccessResponse + withErrorResponse`. */
  withResponse: number;
  withoutResponse: number;
  withSuccessResponse: number;
  withErrorResponse: number;
  /**
   * Responses whose recorded body had zero bytes. Independent of the
   * success/error axis (body content itself is never persisted).
   */
  emptyResponse: number;
}

/**
 * Split manifest entries on two independent axes: whether a response arrived
 * (and whether its status is 2xx), and whether its recorded body was empty.
 */
export function responseAccounting(
  entries: readonly ManifestCaptureEntry[],
): ResponseAccounting {
  let withSuccessResponse = 0;
  let withErrorResponse = 0;
  let emptyResponse = 0;
  for (const entry of entries) {
    const status = entry.responseStatus;
    if (status === null) continue;
    if (isSuccessResponseStatus(status)) withSuccessResponse += 1;
    else withErrorResponse += 1;
    if (entry.responseBytes === 0) emptyResponse += 1;
  }
  const withResponse = withSuccessResponse + withErrorResponse;
  return {
    withResponse,
    withoutResponse: entries.length - withResponse,
    withSuccessResponse,
    withErrorResponse,
    emptyResponse,
  };
}

/** sha256 of the canonical manifest document (for audit/idempotency checks). */
export function manifestHash(manifest: CaptureManifest): string {
  return sha256Hex(canonicalJson(manifest));
}

export interface CaptureStoreOptions {
  /** Store root directory (created on first write). */
  root: string;
  /** Clock injection so tests and mock runs stay deterministic. */
  now?: () => Date;
}

export interface WrittenCapture {
  file: string;
  absolutePath: string;
  captureHash: string;
  entry: ManifestCaptureEntry;
}

/**
 * Writes capture records and maintains `manifest.json`. Records are merged into
 * an existing manifest by file path, so re-running one op updates its entry
 * instead of duplicating it.
 */
export class CaptureStore {
  readonly root: string;
  private readonly now: () => Date;
  private readonly written = new Map<string, ManifestCaptureEntry>();

  constructor(options: CaptureStoreOptions) {
    this.root = options.root;
    this.now = options.now ?? (() => new Date());
  }

  async write(record: CaptureRecord): Promise<WrittenCapture> {
    assertCaptureRecord(record);
    if (!record.redaction.clean) {
      throw new Error(
        "refusing to persist a capture record whose redaction report is not clean",
      );
    }
    assertNoPii(record, "capture record");
    const file = captureRelativePath(record);
    const absolutePath = join(this.root, ...file.split("/"));
    const text = `${JSON.stringify(record, null, 2)}\n`;
    await mkdir(join(this.root, captureDateDir(record.capturedAt)), {
      recursive: true,
    });
    await atomicWriteText(absolutePath, text);
    const entry = manifestEntryFor(record, file);
    this.written.set(file, entry);
    return {
      file,
      absolutePath,
      captureHash: entry.captureHash,
      entry,
    };
  }

  /** Merge this run's entries into the manifest and write it atomically. */
  async finalize(): Promise<CaptureManifest> {
    const existing = await readCaptureManifest(this.root);
    const merged = new Map<string, ManifestCaptureEntry>();
    for (const entry of existing?.captures ?? []) merged.set(entry.file, entry);
    for (const [file, entry] of this.written) merged.set(file, entry);
    const captures = [...merged.values()].sort((left, right) =>
      left.file.localeCompare(right.file),
    );
    const manifest: CaptureManifest = {
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      store: CAPTURE_STORE_NAME,
      generatedAt: this.now().toISOString(),
      policyVersion: REDACTION_POLICY_VERSION,
      counts: {
        total: captures.length,
        live: captures.filter((entry) => entry.mode === "live").length,
        mock: captures.filter((entry) => entry.mode === "mock").length,
        // withResponse stays "any HTTP response" for backward compatibility;
        // the success/error/empty split is the strict view.
        ...responseAccounting(captures),
        clean: captures.filter((entry) => entry.redaction.clean).length,
        operations: [
          ...new Set(captures.map((entry) => entry.operation.path)),
        ].sort(),
      },
      captures,
    };
    await mkdir(this.root, { recursive: true });
    await atomicWriteText(
      join(this.root, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  }

  /** Read the current on-disk manifest, if any. */
  async loadManifest(): Promise<CaptureManifest | null> {
    return readCaptureManifest(this.root);
  }
}

/** Read and validate `<root>/manifest.json`; null when it does not exist yet. */
export async function readCaptureManifest(
  root: string,
): Promise<CaptureManifest | null> {
  let text: string;
  try {
    text = await readFile(join(root, MANIFEST_FILE), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`capture manifest at ${root} is not valid JSON`);
  }
  return assertCaptureManifest(parsed);
}

export interface LoadedCapture {
  entry: ManifestCaptureEntry;
  record: CaptureRecord;
}

export interface LoadedCaptureStore {
  manifest: CaptureManifest;
  captures: LoadedCapture[];
}

/**
 * Load a store and verify every record still hashes to its manifest entry.
 * A mismatch means the file was edited after capture and must not be trusted.
 */
export async function loadCaptureStore(
  root: string,
): Promise<LoadedCaptureStore> {
  const manifest = await readCaptureManifest(root);
  if (manifest === null) {
    throw new Error(`no capture manifest found under ${root}`);
  }
  const captures: LoadedCapture[] = [];
  for (const entry of manifest.captures) {
    const absolutePath = join(root, ...entry.file.split("/"));
    const text = await readFile(absolutePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`capture record ${entry.file} is not valid JSON`);
    }
    const record = assertCaptureRecord(parsed);
    const actualHash = captureHash(record);
    if (actualHash !== entry.captureHash) {
      throw new Error(
        `capture record ${entry.file} does not match its manifest hash (edited after capture)`,
      );
    }
    captures.push({ entry, record });
  }
  return { manifest, captures };
}

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

function fail(field: string, expected: string): never {
  throw new Error(`invalid capture record: ${field} must be ${expected}`);
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field, "a string");
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(field, "a finite number");
  }
  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field, "a boolean");
  return value;
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(field, "an object");
  return value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(field, "an array of strings");
  }
  return value;
}

function expectSkeleton(value: unknown, field: string): Skeleton {
  const skeleton = expectObject(value, field);
  const type = expectString(skeleton["type"], `${field}.type`);
  const nullable = expectBoolean(skeleton["nullable"], `${field}.nullable`);
  const truncated =
    skeleton["truncated"] === undefined
      ? false
      : expectBoolean(skeleton["truncated"], `${field}.truncated`);
  switch (type) {
    case "object": {
      const fields = expectObject(skeleton["fields"], `${field}.fields`);
      const built: Record<string, Skeleton> = {};
      for (const [key, child] of Object.entries(fields)) {
        built[key] = expectSkeleton(child, `${field}.fields.${key}`);
      }
      const out: Skeleton = { type: "object", nullable, fields: built };
      if (truncated) out.truncated = true;
      return out;
    }
    case "array": {
      const items = skeleton["items"];
      const out: Skeleton = {
        type: "array",
        nullable,
        items: items === null ? null : expectSkeleton(items, `${field}.items`),
      };
      if (truncated) out.truncated = true;
      return out;
    }
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "unknown": {
      const out: Skeleton = { type, nullable };
      if (skeleton["enumCandidates"] !== undefined) {
        out.enumCandidates = expectStringArray(
          skeleton["enumCandidates"],
          `${field}.enumCandidates`,
        );
      }
      if (truncated) out.truncated = true;
      return out;
    }
    default:
      fail(`${field}.type`, "a known skeleton type");
  }
}

const PII_KINDS: ReadonlySet<string> = new Set<PiiKind>([
  "email",
  "ip",
  "phone",
  "jwt",
  "bearer",
  "customer-id",
  "login",
  "agent-id",
  "password",
  "token",
  "address",
]);

function isPiiKind(value: string): value is PiiKind {
  return PII_KINDS.has(value);
}

function expectPiiKinds(value: unknown, field: string): PiiKind[] {
  const values = expectStringArray(value, field);
  const kinds: PiiKind[] = [];
  for (const item of values) {
    if (!isPiiKind(item)) fail(field, `a known PII kind (got "${item}")`);
    kinds.push(item);
  }
  return kinds;
}

function expectOperation(value: unknown, field: string): OperationRef {
  const operation = expectObject(value, field);
  const method = expectString(operation["method"], `${field}.method`);
  if (method !== "GET" && method !== "POST") {
    fail(`${field}.method`, "GET or POST");
  }
  const result: OperationRef = {
    path: expectString(operation["path"], `${field}.path`),
    method,
  };
  if (operation["operationId"] !== undefined) {
    result.operationId = expectString(
      operation["operationId"],
      `${field}.operationId`,
    );
  }
  return result;
}

function expectProvenance(value: unknown, field: string): CaptureProvenance {
  const provenance = expectObject(value, field);
  const proxy = expectString(provenance["proxy"], `${field}.proxy`);
  if (proxy !== "env" && proxy !== "none") {
    fail(`${field}.proxy`, '"env" or "none"');
  }
  const auth = expectString(provenance["auth"], `${field}.auth`);
  if (auth !== "cookie" && auth !== "none") {
    fail(`${field}.auth`, '"cookie" or "none"');
  }
  return {
    portalHost: expectString(provenance["portalHost"], `${field}.portalHost`),
    proxy,
    auth,
    bunVersion: expectString(provenance["bunVersion"], `${field}.bunVersion`),
  };
}

/** Validate an untrusted value as a capture record (boundary parse). */
export function assertCaptureRecord(value: unknown): CaptureRecord {
  const record = expectObject(value, "record");
  if (record["schemaVersion"] !== CAPTURE_SCHEMA_VERSION) {
    fail("schemaVersion", `${CAPTURE_SCHEMA_VERSION}`);
  }
  const mode = expectString(record["mode"], "mode");
  if (mode !== "live" && mode !== "mock") fail("mode", '"live" or "mock"');
  const capturedAt = expectString(record["capturedAt"], "capturedAt");
  if (Number.isNaN(new Date(capturedAt).getTime())) {
    fail("capturedAt", "an ISO date");
  }
  const operation = expectOperation(record["operation"], "operation");
  const request = expectObject(record["request"], "request");
  expectString(request["url"], "request.url");
  const requestMethod = expectString(request["method"], "request.method");
  if (requestMethod !== "GET" && requestMethod !== "POST") {
    fail("request.method", "GET or POST");
  }
  expectString(request["contentType"], "request.contentType");
  expectString(request["bodySha256"], "request.bodySha256");
  if (request["bodySkeleton"] !== null) {
    expectSkeleton(request["bodySkeleton"], "request.bodySkeleton");
  }
  const headers = expectObject(request["headers"], "request.headers");
  for (const [name, headerValue] of Object.entries(headers)) {
    expectString(headerValue, `request.headers.${name}`);
  }

  const rawResponse = record["response"];
  let responseCapture: CapturedResponse | null = null;
  if (rawResponse !== null && rawResponse !== undefined) {
    const response = expectObject(rawResponse, "response");
    responseCapture = {
      status: expectNumber(response["status"], "response.status"),
      contentType: expectString(
        response["contentType"],
        "response.contentType",
      ),
      bodySha256: expectString(response["bodySha256"], "response.bodySha256"),
      bodySkeleton: expectSkeleton(
        response["bodySkeleton"],
        "response.bodySkeleton",
      ),
      bytes: expectNumber(response["bytes"], "response.bytes"),
    };
  }

  const redaction = expectObject(record["redaction"], "redaction");
  expectNumber(redaction["policyVersion"], "redaction.policyVersion");
  expectBoolean(redaction["clean"], "redaction.clean");
  expectStringArray(redaction["fieldsRedacted"], "redaction.fieldsRedacted");
  expectStringArray(redaction["piiRedacted"], "redaction.piiRedacted");
  const provenance = expectProvenance(record["provenance"], "provenance");
  const samples = expectNumber(record["samples"], "samples");
  if (!Number.isInteger(samples) || samples < 1) {
    fail("samples", "a positive integer");
  }

  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    mode,
    capturedAt,
    operation,
    request: {
      url: expectString(request["url"], "request.url"),
      method: requestMethod,
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, headerValue]) => [
          name,
          expectString(headerValue, `request.headers.${name}`),
        ]),
      ),
      contentType: expectString(request["contentType"], "request.contentType"),
      bodySha256: expectString(request["bodySha256"], "request.bodySha256"),
      bodySkeleton:
        request["bodySkeleton"] === null
          ? null
          : expectSkeleton(request["bodySkeleton"], "request.bodySkeleton"),
    },
    response: responseCapture,
    redaction: {
      policyVersion: REDACTION_POLICY_VERSION,
      clean: expectBoolean(redaction["clean"], "redaction.clean"),
      fieldsRedacted: expectStringArray(
        redaction["fieldsRedacted"],
        "redaction.fieldsRedacted",
      ),
      piiRedacted: expectPiiKinds(
        redaction["piiRedacted"],
        "redaction.piiRedacted",
      ),
    },
    provenance,
    samples,
  };
}

/** Validate an untrusted manifest document. */
export function assertCaptureManifest(value: unknown): CaptureManifest {
  const manifest = expectObject(value, "manifest");
  if (manifest["schemaVersion"] !== CAPTURE_SCHEMA_VERSION) {
    fail("manifest.schemaVersion", `${CAPTURE_SCHEMA_VERSION}`);
  }
  if (manifest["store"] !== CAPTURE_STORE_NAME) {
    fail("manifest.store", `"${CAPTURE_STORE_NAME}"`);
  }
  const rawCaptures = manifest["captures"];
  if (!Array.isArray(rawCaptures)) fail("manifest.captures", "an array");
  const captures: ManifestCaptureEntry[] = rawCaptures.map(
    (rawEntry, index) => {
      const entry = expectObject(rawEntry, `manifest.captures[${index}]`);
      const mode = expectString(entry["mode"], "mode");
      if (mode !== "live" && mode !== "mock") fail("mode", '"live" or "mock"');
      const redaction = expectObject(entry["redaction"], "redaction");
      return {
        file: expectString(entry["file"], "file"),
        mode,
        capturedAt: expectString(entry["capturedAt"], "capturedAt"),
        operation: expectOperation(entry["operation"], "operation"),
        captureHash: expectString(entry["captureHash"], "captureHash"),
        requestBodySha256: expectString(
          entry["requestBodySha256"],
          "requestBodySha256",
        ),
        responseStatus:
          entry["responseStatus"] === null
            ? null
            : expectNumber(entry["responseStatus"], "responseStatus"),
        responseBodySha256:
          entry["responseBodySha256"] === null
            ? null
            : expectString(entry["responseBodySha256"], "responseBodySha256"),
        responseBytes:
          entry["responseBytes"] === null
            ? null
            : expectNumber(entry["responseBytes"], "responseBytes"),
        redaction: {
          policyVersion: REDACTION_POLICY_VERSION,
          clean: expectBoolean(redaction["clean"], "redaction.clean"),
          fieldsRedacted: expectNumber(
            redaction["fieldsRedacted"],
            "redaction.fieldsRedacted",
          ),
          piiRedacted: expectNumber(
            redaction["piiRedacted"],
            "redaction.piiRedacted",
          ),
        },
        provenance: expectProvenance(entry["provenance"], "provenance"),
        samples: expectNumber(entry["samples"], "samples"),
      };
    },
  );
  const counts = expectObject(manifest["counts"], "manifest.counts");
  const total = expectNumber(counts["total"], "counts.total");
  const withResponse = expectNumber(
    counts["withResponse"],
    "counts.withResponse",
  );
  const withoutResponse = expectNumber(
    counts["withoutResponse"],
    "counts.withoutResponse",
  );
  const withSuccessResponse = expectNumber(
    counts["withSuccessResponse"],
    "counts.withSuccessResponse",
  );
  const withErrorResponse = expectNumber(
    counts["withErrorResponse"],
    "counts.withErrorResponse",
  );
  const emptyResponse = expectNumber(
    counts["emptyResponse"],
    "counts.emptyResponse",
  );
  // Success and error partition `withResponse`; a body can only be empty when
  // a response was actually recorded.
  if (withSuccessResponse + withErrorResponse !== withResponse) {
    fail("counts.withResponse", "withSuccessResponse + withErrorResponse");
  }
  if (withResponse + withoutResponse !== total) {
    fail("counts.total", "withResponse + withoutResponse");
  }
  if (emptyResponse > withResponse) {
    fail("counts.emptyResponse", "no greater than counts.withResponse");
  }
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    store: CAPTURE_STORE_NAME,
    generatedAt: expectString(manifest["generatedAt"], "generatedAt"),
    policyVersion: REDACTION_POLICY_VERSION,
    counts: {
      total,
      live: expectNumber(counts["live"], "counts.live"),
      mock: expectNumber(counts["mock"], "counts.mock"),
      withResponse,
      withoutResponse,
      withSuccessResponse,
      withErrorResponse,
      emptyResponse,
      clean: expectNumber(counts["clean"], "counts.clean"),
      operations: expectStringArray(counts["operations"], "counts.operations"),
    },
    captures,
  };
}

async function atomicWriteText(path: string, text: string): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmpPath, text, "utf8");
  await rename(tmpPath, path);
}
