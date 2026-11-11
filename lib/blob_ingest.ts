/**
 * @file lib/blob_ingest.ts
 * @description Unified Blob-first automation & ingestion pipeline for Bun 1.4.4+.
 *
 * Unifies the five binary/text surfaces across sportsdesk-ops around web-standard `Blob`:
 * 1. `fetch()` -> `await res.blob()` (with decompression-aware `content-length` verification)
 * 2. `Bun.file(path)` -> `BunFile` / `FileBlob` (lazy `Blob` subclasses from `"bun"`)
 * 3. `Bun.WebView.screenshot({ encoding: "blob" })` & `new Bun.Image(blob).blob()`
 * 4. `scripts/capture/recorder.ts` (`RecordResponseInput` & `CaptureRecord` from `Blob`/`Response`)
 * 5. `lib/combo_identity.ts` & `lib/fantasy402_settlement_ingest.ts` (F402 `Pending` / `getGrading` /
 *    `getTransactions` / `getHistory` direct `Blob` ingestion with wire SHA-256 provenance and
 *    explicit polymorphic `LIST: ""` empty-envelope handling).
 */

import type { BunFile, FileBlob } from "bun";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Sha256Hex } from "../design/domain-branded-types.ts";
import { auditRunId, type AuditRunId } from "./audit_run_id.ts";
import {
  groupF402PendingRowsByTicket,
  type F402CustomerReportPendingRow,
  type GroupedF402ParentTicket,
} from "./combo_identity.ts";
import {
  type SettlementFeed,
  type WagerSettlementStore,
} from "./fantasy402_settlement_ingest.ts";
import { isPlainObject, sha256Hex } from "../scripts/capture/json.ts";
import {
  buildCaptureRecord,
  type BuildRecordInput,
  type RecordResponseInput,
} from "../scripts/capture/recorder.ts";
import type { CaptureRecord } from "../scripts/capture/types.ts";

/**
 * Any binary/text payload that can be normalized into a `Blob` without intermediate string transcoding.
 */
export type BlobSource = Blob | Response | Uint8Array | ArrayBuffer | string;

export interface InspectedBlob {
  readonly blob: Blob;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly mimeType: string;
  readonly sha256: Sha256Hex;
}

export interface VerifiedWriteResult extends InspectedBlob {
  readonly path: string;
  readonly writtenBytes: number;
}

export interface StreamVerifiedBlobOptions {
  readonly fallbackMimeType?: string;
  readonly highWaterMark?: number;
  readonly maxBytes?: number;
}

export interface StreamVerifiedWriteResult {
  readonly path: string;
  readonly size: number;
  readonly writtenBytes: number;
  readonly mimeType: string;
  readonly sha256: Sha256Hex;
}

export interface FetchVerifiedBlobOptions extends BunFetchRequestInit {
  /** Optional local destination path; when set, writes via `Bun.write` and verifies disk stat. */
  readonly writeTo?: string;
  /** If true (default), throws on non-2xx HTTP status codes. */
  readonly requireOk?: boolean;
  /** Optional custom fetch implementation for deterministic unit testing. */
  readonly fetcher?: (
    input: string | URL | Request,
    init?: BunFetchRequestInit,
  ) => Promise<Response>;
}

export interface FetchVerifiedBlobResult extends InspectedBlob {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly contentEncoding: string | null;
  readonly wireContentLength: number | null;
  readonly wireCompressed: boolean;
  readonly writtenPath: string | null;
}

/**
 * Runtime guard narrowing a web `Blob` to a canonical `BunFile` / `FileBlob` handle (`Bun.file(...)`).
 */
export function isBunFile(value: Blob): value is BunFile | FileBlob {
  return (
    typeof (value as Partial<BunFile>).stat === "function" &&
    typeof (value as Partial<BunFile>).writer === "function"
  );
}

async function assertSafeWriteDestination(destPath: string): Promise<void> {
  const existing = await lstat(destPath).catch(() => null);
  if (existing === null) return;
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Error(
      `refusing to write to non-regular or symlink destination: ${destPath}`,
    );
  }
}

async function verifyWrittenRegularFile(
  destPath: string,
  expectedBytes: number,
  reportedWrittenBytes?: number,
): Promise<number> {
  const [linkStat, diskStat] = await Promise.all([
    lstat(destPath),
    Bun.file(destPath).stat(),
  ]);
  if (
    linkStat.isSymbolicLink() ||
    !linkStat.isFile() ||
    !diskStat.isFile() ||
    linkStat.ino !== diskStat.ino ||
    linkStat.dev !== diskStat.dev
  ) {
    throw new Error(
      `post-write verification failed for ${destPath}: destination is not a stable regular file`,
    );
  }
  if (
    reportedWrittenBytes !== undefined &&
    reportedWrittenBytes !== expectedBytes
  ) {
    throw new Error(
      `partial write to ${destPath}: Bun.write reported ${reportedWrittenBytes} B, expected ${expectedBytes} B`,
    );
  }
  if (diskStat.size !== expectedBytes) {
    throw new Error(
      `partial write to ${destPath}: stat reported ${diskStat.size} B, expected ${expectedBytes} B`,
    );
  }
  return diskStat.size;
}

/**
 * Repairs a truncated JSON array preview (e.g. `{"Pending":[{...},{...truncated`) by slicing
 * after the first complete object and closing `]}`.
 */
export function repairTruncatedJson(preview: string): string | null {
  const firstObjEnd = preview.indexOf("},{");
  if (firstObjEnd !== -1) {
    return `${preview.slice(0, firstObjEnd + 1)}]}`;
  }
  return null;
}

/**
 * Enforces the polymorphic F402 `LIST` / `Pending` / `data` envelope contract:
 * - On `/cloud/api/Report/getGrading` and `/cloud/api/Manager/getTransactions`, an empty result set
 *   is serialized on the wire as `{"LIST": ""}` (a JSON string `""`, not `[]` or `null`).
 * - Returns `[]` when the envelope field is `""`, `null`, or `undefined`.
 * - Returns the filtered object array when the envelope field is an Array.
 * - Throws an explicit error if the field is any other unexpected primitive or object shape.
 */
export function parseF402ListEnvelope(
  json: unknown,
  field: "LIST" | "Pending" | "data" = "LIST",
): Record<string, unknown>[] {
  if (!isPlainObject(json)) {
    throw new Error(`unexpected envelope shape: ${typeof json}`);
  }
  const list = json[field];
  if (list === "" || list == null) return [];
  if (Array.isArray(list)) return list.filter(isPlainObject);
  throw new Error(`unexpected ${field} shape: ${typeof list}`);
}

/**
 * Normalizes any `BlobSource` into a `Blob` with an explicit MIME type.
 * Uses zero-copy `Blob.prototype.slice` / `BunFile.slice` when re-tagging MIME types so lazy
 * `BunFile` handles are not eagerly materialized into heap `Uint8Array` buffers.
 */
export async function toBlob(
  source: BlobSource,
  fallbackMimeType = "application/octet-stream",
): Promise<Blob> {
  if (source instanceof Response) {
    const headerType = source.headers.get("content-type")?.trim();
    const targetType = headerType || fallbackMimeType;
    const rawBlob = await source.blob();
    if (
      rawBlob.type !== "" &&
      (rawBlob.type !== "application/octet-stream" ||
        targetType === "application/octet-stream")
    ) {
      return rawBlob;
    }
    return rawBlob.slice(0, undefined, targetType);
  }
  if (source instanceof Blob) {
    if (
      source.type !== "" &&
      (source.type !== "application/octet-stream" ||
        fallbackMimeType === "application/octet-stream")
    ) {
      return source;
    }
    return isBunFile(source)
      ? source.slice(0, fallbackMimeType)
      : source.slice(0, undefined, fallbackMimeType);
  }
  if (typeof source === "string") {
    return new Blob([source], {
      type:
        fallbackMimeType === "application/octet-stream"
          ? "text/plain;charset=utf-8"
          : fallbackMimeType,
    });
  }
  if (source instanceof Uint8Array) {
    return new Blob([source], { type: fallbackMimeType });
  }
  return new Blob([new Uint8Array(source)], { type: fallbackMimeType });
}

/**
 * Materializes a `BlobSource` once into `{ blob, bytes, size, mimeType, sha256 }`.
 * Uses `await blob.bytes()` in Bun 1.4.4+ for single-pass byte extraction.
 */
export async function inspectBlobSource(
  source: BlobSource,
  fallbackMimeType = "application/octet-stream",
): Promise<InspectedBlob> {
  const blob = await toBlob(source, fallbackMimeType);
  const bytes = await blob.bytes();
  const mimeType = blob.type || fallbackMimeType;
  const sha256 = sha256Hex(bytes) as Sha256Hex;
  return {
    blob,
    bytes,
    size: bytes.byteLength,
    mimeType,
    sha256,
  };
}

/**
 * Writes a `BlobSource` to disk via `Bun.write(dest, blob)` and verifies post-write
 * `lstat(dest)` + `await Bun.file(dest).stat()` against `inspected.size` (never synchronous
 * `Bun.file(dest).size`, which is unpopulated before a read/stat).
 */
export async function writeVerifiedBlob(
  destPath: string,
  source: BlobSource,
  fallbackMimeType = "application/octet-stream",
): Promise<VerifiedWriteResult> {
  const inspected = await inspectBlobSource(source, fallbackMimeType);
  await mkdir(dirname(destPath), { recursive: true });
  await assertSafeWriteDestination(destPath);
  const reportedWritten = await Bun.write(destPath, inspected.blob);
  const writtenBytes = await verifyWrittenRegularFile(
    destPath,
    inspected.size,
    reportedWritten,
  );
  return {
    ...inspected,
    path: destPath,
    writtenBytes,
  };
}

/**
 * Streams a `Blob`, `Response`, or `ReadableStream<Uint8Array>` to disk via `Blob.prototype.stream()`
 * + `Bun.CryptoHasher("sha256")` + `Bun.file(dest).writer()` (`Bun.FileSink`) without buffering the
 * full payload in heap memory, then verifies `lstat(dest)` + `Bun.file(dest).stat()`.
 */
export async function streamVerifiedBlobToFile(
  destPath: string,
  source: Blob | Response | ReadableStream<Uint8Array>,
  options: StreamVerifiedBlobOptions = {},
): Promise<StreamVerifiedWriteResult> {
  const fallbackMimeType =
    options.fallbackMimeType ?? "application/octet-stream";
  let mimeType = fallbackMimeType;
  let stream: ReadableStream<Uint8Array> | null;

  if (source instanceof Response) {
    mimeType = source.headers.get("content-type")?.trim() || fallbackMimeType;
    stream = source.body;
  } else if (source instanceof Blob) {
    mimeType = source.type || fallbackMimeType;
    stream = source.stream();
  } else {
    stream = source;
  }

  await mkdir(dirname(destPath), { recursive: true });
  await assertSafeWriteDestination(destPath);

  const hasher = new Bun.CryptoHasher("sha256");
  const destFile = Bun.file(destPath);
  const sink =
    options.highWaterMark !== undefined
      ? destFile.writer({ highWaterMark: options.highWaterMark })
      : destFile.writer();

  let totalBytes = 0;
  try {
    if (stream !== null) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength === 0) continue;
          totalBytes += value.byteLength;
          if (options.maxBytes !== undefined && totalBytes > options.maxBytes) {
            await reader.cancel("maxBytes exceeded");
            throw new Error(
              `stream to ${destPath} exceeded maxBytes (${totalBytes} B > ${options.maxBytes} B)`,
            );
          }
          hasher.update(value);
          const flushed = sink.write(value);
          if (flushed instanceof Promise) await flushed;
        }
      } finally {
        reader.releaseLock();
      }
    }
    const ended = sink.end();
    if (ended instanceof Promise) await ended;
  } catch (err) {
    await Promise.resolve(sink.end()).catch(() => undefined);
    await rm(destPath, { force: true }).catch(() => undefined);
    throw err;
  }

  const writtenBytes = await verifyWrittenRegularFile(destPath, totalBytes);
  return {
    path: destPath,
    size: totalBytes,
    writtenBytes,
    mimeType,
    sha256: hasher.digest("hex") as Sha256Hex,
  };
}

/**
 * Fetches a URL into a verified `Blob` with decompression-aware `content-length` checking:
 * - Enforces `res.ok` when `requireOk !== false`.
 * - Enforces `Number(contentLength) === blob.size` when `content-encoding` is absent or `"identity"`.
 * - Records `wireCompressed: true` and `wireContentLength` when `gzip` / `br` / `zstd` / `deflate`
 *   transparently expanded the body in `fetch()`.
 * - Optionally persists and stat-verifies the `Blob` on disk when `writeTo` is provided.
 */
export async function fetchVerifiedBlob(
  url: string,
  options: FetchVerifiedBlobOptions = {},
): Promise<FetchVerifiedBlobResult> {
  const {
    writeTo,
    requireOk = true,
    fetcher = fetch,
    ...requestInit
  } = options;

  const response = await fetcher(url, requestInit);
  if (requireOk && !response.ok) {
    const preview = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${response.status} from ${url}: ${preview}`);
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const contentType = headers["content-type"] ?? "application/octet-stream";
  const contentEncoding =
    headers["content-encoding"]?.trim().toLowerCase() ?? null;
  const wireCompressed =
    contentEncoding !== null &&
    contentEncoding !== "" &&
    contentEncoding !== "identity";

  const rawCl = headers["content-length"];
  const wireContentLength =
    rawCl !== undefined && rawCl !== "" && Number.isFinite(Number(rawCl))
      ? Number(rawCl)
      : null;

  const inspected = await inspectBlobSource(response, contentType);

  if (
    !wireCompressed &&
    wireContentLength !== null &&
    wireContentLength !== inspected.size
  ) {
    throw new Error(
      `truncated response from ${url}: got ${inspected.size} B, content-length declared ${wireContentLength} B`,
    );
  }

  let writtenPath: string | null = null;
  if (writeTo) {
    await writeVerifiedBlob(writeTo, inspected.blob, inspected.mimeType);
    writtenPath = writeTo;
  }

  return {
    ...inspected,
    url,
    status: response.status,
    headers,
    contentEncoding,
    wireContentLength,
    wireCompressed,
    writtenPath,
  };
}

/**
 * Converts a `Response` or `Blob` directly into a `RecordResponseInput` for `scripts/capture/recorder.ts`.
 */
export async function responseToRecordInput(
  source: Response | Blob,
  options: {
    status?: number;
    headers?: Record<string, string>;
    contentType?: string;
    wireBytes?: number;
    truncatedPreview?: boolean;
  } = {},
): Promise<RecordResponseInput> {
  if (source instanceof Response) {
    const headers: Record<string, string> = { ...options.headers };
    source.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const contentType =
      options.contentType ??
      headers["content-type"] ??
      "application/octet-stream";
    const inspected = await inspectBlobSource(source, contentType);
    const out: RecordResponseInput = {
      status: options.status ?? source.status,
      headers,
      contentType: inspected.mimeType,
      bytes: inspected.bytes,
    };
    if (options.wireBytes !== undefined) out.wireBytes = options.wireBytes;
    if (options.truncatedPreview !== undefined) {
      out.truncatedPreview = options.truncatedPreview;
    }
    return out;
  }

  const inspected = await inspectBlobSource(
    source,
    options.contentType ?? (source.type || "application/octet-stream"),
  );
  const out: RecordResponseInput = {
    status: options.status ?? 200,
    headers: options.headers ?? {},
    contentType: inspected.mimeType,
    bytes: inspected.bytes,
  };
  if (options.wireBytes !== undefined) out.wireBytes = options.wireBytes;
  if (options.truncatedPreview !== undefined) {
    out.truncatedPreview = options.truncatedPreview;
  }
  return out;
}

/**
 * Builds a PII-redacted `CaptureRecord` directly from a `Response` or `Blob` payload.
 */
export async function buildCaptureRecordFromBlob(
  input: Omit<BuildRecordInput, "response"> & {
    response:
      | Response
      | Blob
      | {
          source: Response | Blob;
          status?: number;
          headers?: Record<string, string>;
          contentType?: string;
          wireBytes?: number;
          truncatedPreview?: boolean;
        }
      | null;
  },
): Promise<CaptureRecord> {
  let responseInput: RecordResponseInput | null = null;
  if (input.response !== null) {
    if (input.response instanceof Response || input.response instanceof Blob) {
      responseInput = await responseToRecordInput(input.response);
    } else {
      const { source, ...rest } = input.response;
      responseInput = await responseToRecordInput(source, rest);
    }
  }
  return buildCaptureRecord({
    ...input,
    response: responseInput,
  });
}

export type F402BlobEnvelopeKind =
  | "pending-list"
  | "grading-list"
  | "transactions-list"
  | "empty-list"
  | "webview-probe"
  | "raw-array";

export interface F402ReportBlobIngestResult {
  readonly envelopeKind: F402BlobEnvelopeKind;
  readonly operation: string | null;
  readonly path: string | null;
  readonly status: number;
  readonly wireBytes: number;
  readonly payloadSha256: Sha256Hex;
  readonly mimeType: string;
  readonly truncatedPreview: boolean;
  readonly rawRowCount: number;
  readonly groupedTickets: readonly GroupedF402ParentTicket[];
  readonly settlementIngestedCount: number;
}

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Ingests an F402 Report/Manager response from any `BlobSource` (`Bun.file(".../Pending.json")`,
 * `await res.blob()`, or a `webview-probe` JSON wrapper):
 * 1. Computes `payloadSha256` over the exact `Blob` bytes and decodes UTF-8 from `inspected.bytes`
 *    in a single read (avoiding a second disk/stream read via `inspected.blob.text()`).
 * 2. Unwraps either raw F402 envelopes (`{"Pending":[...]}`, `{"LIST":[...]}`, `{"LIST":""}`) or
 *    `f402_probe.ts` probe files (`{ operation, result: { status, bytes, preview } }` or
 *    `{ operation, response: { status, bytes, bodyPreview } }`), repairing truncated preview slices
 *    when necessary.
 * 3. Enforces the polymorphic `LIST: ""` vs `LIST: [...]` parser contract via `parseF402ListEnvelope()`.
 * 4. Extracts `F402CustomerReportPendingRow[]` and groups multi-leg parlays/teasers by
 *    `TicketNumber-WagerNumber` via `groupF402PendingRowsByTicket()`.
 * 5. When `settlementStore` is passed, normalizes and inserts rows into `WagerSettlementStore`.
 */
export async function ingestF402ReportBlob(
  source: BlobSource,
  options: {
    settlementStore?: WagerSettlementStore;
    settlementFeed?: SettlementFeed;
    runId?: AuditRunId;
    capturedAtUtc?: string;
  } = {},
): Promise<F402ReportBlobIngestResult> {
  const inspected = await inspectBlobSource(source, "application/json");
  const text = UTF8_FATAL_DECODER.decode(inspected.bytes);
  const parsed = JSON.parse(text) as unknown;

  let envelopeKind: F402BlobEnvelopeKind = "empty-list";
  let operation: string | null = null;
  let path: string | null = null;
  let status = 200;
  let wireBytes = inspected.size;
  let truncatedPreview = false;
  let bodyPayload: unknown = parsed;

  // Detect `f402_probe.ts` wrapper (`result.preview` or `response.bodyPreview`)
  const probeInner =
    isPlainObject(parsed) && isPlainObject(parsed["result"])
      ? parsed["result"]
      : isPlainObject(parsed) && isPlainObject(parsed["response"])
        ? parsed["response"]
        : null;
  const previewText =
    probeInner !== null
      ? typeof probeInner["bodyText"] === "string"
        ? probeInner["bodyText"]
        : typeof probeInner["preview"] === "string"
          ? probeInner["preview"]
          : typeof probeInner["bodyPreview"] === "string"
            ? probeInner["bodyPreview"]
            : null
      : null;

  if (isPlainObject(parsed) && probeInner !== null && previewText !== null) {
    envelopeKind = "webview-probe";
    operation =
      typeof parsed["operation"] === "string" ? parsed["operation"] : null;
    if (typeof parsed["path"] === "string") {
      path = parsed["path"];
    } else if (typeof parsed["url"] === "string") {
      try {
        path = new URL(parsed["url"]).pathname;
      } catch {
        path = null;
      }
    }
    status =
      typeof probeInner["status"] === "number" ? probeInner["status"] : 200;
    wireBytes =
      typeof probeInner["bytes"] === "number"
        ? probeInner["bytes"]
        : inspected.size;

    if (previewText.trim().length > 0) {
      try {
        bodyPayload = JSON.parse(previewText);
      } catch {
        const repaired = repairTruncatedJson(previewText);
        if (repaired !== null) {
          bodyPayload = JSON.parse(repaired);
          truncatedPreview = true;
        } else {
          bodyPayload = {};
        }
      }
    } else {
      bodyPayload = {};
    }
  }

  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(bodyPayload)) {
    if (envelopeKind !== "webview-probe") envelopeKind = "raw-array";
    rows = bodyPayload.filter(isPlainObject);
  } else if (isPlainObject(bodyPayload)) {
    if ("Pending" in bodyPayload) {
      if (envelopeKind !== "webview-probe") {
        envelopeKind =
          bodyPayload["Pending"] === "" || bodyPayload["Pending"] == null
            ? "empty-list"
            : "pending-list";
      }
      rows = parseF402ListEnvelope(bodyPayload, "Pending");
    } else if ("LIST" in bodyPayload) {
      const isEmptyStringOrNull =
        bodyPayload["LIST"] === "" || bodyPayload["LIST"] == null;
      if (envelopeKind !== "webview-probe") {
        envelopeKind = isEmptyStringOrNull
          ? "empty-list"
          : operation === "getTransactions"
            ? "transactions-list"
            : "grading-list";
      }
      rows = parseF402ListEnvelope(bodyPayload, "LIST");
    } else if ("data" in bodyPayload) {
      rows = parseF402ListEnvelope(bodyPayload, "data");
    }
  }

  const pendingRows = rows.filter(
    (r) => r["TicketNumber"] !== undefined && r["WagerNumber"] !== undefined,
  ) as unknown as F402CustomerReportPendingRow[];

  const groupedTickets = groupF402PendingRowsByTicket(pendingRows);

  let settlementIngestedCount = 0;
  if (options.settlementStore && rows.length > 0) {
    const capturedAtUtc = options.capturedAtUtc ?? new Date().toISOString();
    const feed: SettlementFeed =
      options.settlementFeed ??
      (operation === "getGrading" || envelopeKind === "grading-list"
        ? "getGrading"
        : "getHistory");
    const runId =
      options.runId ??
      auditRunId(`blob-ingest:${inspected.sha256.slice(0, 12)}`);
    const normalizedWireRows = rows.map((row) => {
      const wn = row["WagerNumber"];
      const numericWn =
        typeof wn === "number"
          ? wn
          : typeof wn === "string" &&
              wn.trim() !== "" &&
              Number.isFinite(Number(wn))
            ? Number(wn)
            : wn;
      const amt = row["Amount"] ?? row["AmountWagered"];
      return {
        ...row,
        WagerNumber: numericWn,
        ...(amt !== undefined ? { Amount: Number(amt) } : {}),
      };
    });
    settlementIngestedCount = options.settlementStore.ingestBatch(
      {
        feed,
        polledAt: capturedAtUtc,
        rows: normalizedWireRows,
      },
      runId,
    );
  }

  return {
    envelopeKind,
    operation,
    path,
    status,
    wireBytes,
    payloadSha256: inspected.sha256,
    mimeType: inspected.mimeType,
    truncatedPreview,
    rawRowCount: rows.length,
    groupedTickets,
    settlementIngestedCount,
  };
}
