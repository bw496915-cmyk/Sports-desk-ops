/**
 * @file tests/support/raw_tcp.ts
 * @description Minimal HTTP/1.1-over-TCP client for wire-level tests. `fetch`
 * normalizes methods, headers and bodies; these tests need the actual status
 * line, header casing, framing and empty 304 body.
 */

export interface RawTcpOptions {
  readonly port: number;
  readonly hostname?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** When false, resolves as soon as the header block arrives. */
  readonly readBody?: boolean;
  /** Port omitted from the default Host header. Default 80. */
  readonly defaultPort?: number;
  /** Default Connection header. Default "close". */
  readonly connection?: "close" | "keep-alive";
}

export interface RawTcpResponse {
  readonly version: string;
  readonly status: number;
  readonly statusText: string;
  readonly loc: string | null;
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly rawHead: string;
  readonly body: Uint8Array;
  readonly framing: "chunked" | "content-length" | "eof" | "none";
  readonly contentLength: number | null;
}

export interface ParsedResponseHead {
  readonly version: string;
  readonly status: number;
  readonly reason: string;
  readonly headers: Record<string, string[]>;
  readonly framing: "chunked" | "content-length" | "eof" | "none";
  readonly contentLength: number | null;
}

export interface BuildRequestOptions {
  readonly defaultPort?: number;
  readonly connection?: "close" | "keep-alive";
}

const CRLF_RE = /[\r\n]/;
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 9110 VCHAR (0x21-0x7e): rejects NUL, CTLs, SP, DEL and non-ASCII.
const NON_VCHAR_RE = /[^\x21-\x7e]/;
// RFC 9110 field-content (ASCII-strict): HTAB + SP/VCHAR.
const INVALID_HEADER_VALUE_RE = /[^\x09\x20-\x7e]/;
const HOST_FORBIDDEN_CHARS_RE = /[/@?#]/;
const CONTENT_LENGTH_RE = /^\d+$/;
const STATUS_LINE_RE = /^(HTTP\/1\.[01]) (\d{3})(?: ([^\r\n]*))?$/;
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("latin1");

type RawTcpSocket = Awaited<ReturnType<typeof Bun.connect>>;

function assertNoCrlf(value: string, label: string): void {
  if (CRLF_RE.test(value)) {
    throw new Error(`[ERR_RAW_TCP_INVALID_HEADER] CR/LF forbidden in ${label}`);
  }
}

export function formatHostHeader(
  hostname: string,
  port: number,
  defaultPort = 80,
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[ERR_RAW_TCP_INVALID_PORT] Invalid TCP port ${port}`);
  }

  const normalizedHost = hostname.trim();
  if (
    normalizedHost.length === 0 ||
    NON_VCHAR_RE.test(normalizedHost) ||
    HOST_FORBIDDEN_CHARS_RE.test(normalizedHost)
  ) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_HEADER] Invalid hostname "${hostname}"`,
    );
  }

  let host: string;
  if (normalizedHost.startsWith("[")) {
    const inner = normalizedHost.slice(1, -1);
    if (
      !normalizedHost.endsWith("]") ||
      inner.includes("[") ||
      inner.includes("]")
    ) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Malformed IPv6 host "${hostname}"`,
      );
    }
    host = normalizedHost;
  } else {
    const colonCount = normalizedHost.split(":").length - 1;
    if (colonCount === 1) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Hostname must not embed port "${hostname}"`,
      );
    }
    host = colonCount >= 2 ? `[${normalizedHost}]` : normalizedHost;
  }

  return port === defaultPort ? host : `${host}:${port}`;
}

export function buildRequestPayload(
  rawTarget: string,
  method: string,
  hostname: string,
  port: number,
  headers: Readonly<Record<string, string>>,
  bodyBytes: Uint8Array | null,
  options: BuildRequestOptions = {},
): Uint8Array {
  assertNoCrlf(method, "method");
  assertNoCrlf(rawTarget, "rawTarget");

  if (!TOKEN_RE.test(method)) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_METHOD] Invalid HTTP method "${method}"`,
    );
  }
  if (
    rawTarget.length === 0 ||
    NON_VCHAR_RE.test(rawTarget) ||
    rawTarget.includes("#")
  ) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_TARGET] Invalid request target "${rawTarget}"`,
    );
  }

  const seenLower = new Set<string>();
  const customLines: string[] = [];
  let explicitContentLength: string | undefined;

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    assertNoCrlf(rawKey, "header key");
    assertNoCrlf(rawValue, `header value for "${rawKey}"`);
    if (INVALID_HEADER_VALUE_RE.test(rawValue)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid character in header value for "${rawKey}"`,
      );
    }

    const key = rawKey.trim();
    if (!TOKEN_RE.test(key)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid header name "${rawKey}"`,
      );
    }

    const lower = key.toLowerCase();
    // Keep the first occurrence to prevent duplicate-header smuggling.
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);

    const trimmedValue = rawValue.trim();
    if (lower === "content-length") explicitContentLength = trimmedValue;
    customLines.push(`${key}: ${trimmedValue}`);
  }

  if (seenLower.has("content-length") && seenLower.has("transfer-encoding")) {
    throw new Error(
      "[ERR_RAW_TCP_INVALID_HEADER] Conflicting Content-Length and Transfer-Encoding headers",
    );
  }

  if (explicitContentLength !== undefined) {
    if (!CONTENT_LENGTH_RE.test(explicitContentLength)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid Content-Length "${explicitContentLength}"`,
      );
    }
    const declared = Number(explicitContentLength);
    const actual = bodyBytes?.byteLength ?? 0;
    if (declared !== actual) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Content-Length (${declared}) does not match body length (${actual})`,
      );
    }
  }

  const lines = [`${method} ${rawTarget} HTTP/1.1`];

  if (!seenLower.has("host")) {
    const hostValue = formatHostHeader(
      hostname,
      port,
      options.defaultPort ?? 80,
    );
    assertNoCrlf(hostValue, "Host");
    lines.push(`Host: ${hostValue}`);
  }

  if (!seenLower.has("connection")) {
    lines.push(`Connection: ${options.connection ?? "close"}`);
  }

  lines.push(...customLines);

  if (
    bodyBytes !== null &&
    bodyBytes.byteLength > 0 &&
    !seenLower.has("content-length") &&
    !seenLower.has("transfer-encoding")
  ) {
    lines.push(`Content-Length: ${bodyBytes.byteLength}`);
  }

  const headPayload = TEXT_ENCODER.encode(`${lines.join("\r\n")}\r\n\r\n`);
  if (bodyBytes === null || bodyBytes.byteLength === 0) return headPayload;

  const out = new Uint8Array(headPayload.byteLength + bodyBytes.byteLength);
  out.set(headPayload, 0);
  out.set(bodyBytes, headPayload.byteLength);
  return out;
}

export function parseResponseHead(
  rawHead: Uint8Array | string,
): ParsedResponseHead {
  const text =
    typeof rawHead === "string" ? rawHead : TEXT_DECODER.decode(rawHead);
  const lines = text.split("\r\n");
  const statusLine = lines[0] ?? "";
  const statusMatch = STATUS_LINE_RE.exec(statusLine);
  if (statusMatch === null) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_STATUS] Malformed HTTP status line "${statusLine}"`,
    );
  }

  const version = statusMatch[1] ?? "";
  const status = Number(statusMatch[2] ?? "");
  const reason = statusMatch[3] ?? "";
  const headers: Record<string, string[]> = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "") break;
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Malformed response header "${line}"`,
      );
    }

    const name = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1).trim();
    if (!TOKEN_RE.test(name)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid response header name "${name}"`,
      );
    }
    if (INVALID_HEADER_VALUE_RE.test(value)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid response header value for "${name}"`,
      );
    }

    const lower = name.toLowerCase();
    (headers[lower] ??= []).push(value);
  }

  const bodyless =
    (status >= 100 && status < 200) || status === 204 || status === 304;
  if (bodyless) {
    return {
      version,
      status,
      reason,
      headers,
      framing: "none",
      contentLength: null,
    };
  }

  const transferEncoding = headers["transfer-encoding"];
  const contentLengths = headers["content-length"];

  if (transferEncoding !== undefined && contentLengths !== undefined) {
    throw new Error(
      "[ERR_RAW_TCP_INVALID_HEADER] Conflicting Content-Length and Transfer-Encoding in response",
    );
  }

  if (transferEncoding !== undefined) {
    const tokens = transferEncoding
      .join(",")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);
    if (tokens[tokens.length - 1] !== "chunked") {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Unsupported Transfer-Encoding "${transferEncoding.join(", ")}"`,
      );
    }
    return {
      version,
      status,
      reason,
      headers,
      framing: "chunked",
      contentLength: null,
    };
  }

  if (contentLengths !== undefined) {
    const first = contentLengths[0];
    if (
      first === undefined ||
      new Set(contentLengths).size !== 1 ||
      !CONTENT_LENGTH_RE.test(first)
    ) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid or conflicting Content-Length "${contentLengths.join(", ")}"`,
      );
    }
    return {
      version,
      status,
      reason,
      headers,
      framing: "content-length",
      contentLength: Number(first),
    };
  }

  return {
    version,
    status,
    reason,
    headers,
    framing: "eof",
    contentLength: null,
  };
}

function findCrlf(buffer: Uint8Array, start: number): number {
  for (let i = start; i + 1 < buffer.byteLength; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) return i;
  }
  return -1;
}

function parseChunkSize(line: string): number {
  const semicolon = line.indexOf(";");
  const hexPart = (semicolon === -1 ? line : line.slice(0, semicolon)).trim();
  if (!/^[0-9a-fA-F]+$/.test(hexPart)) {
    throw new Error(`[ERR_RAW_TCP_INVALID_CHUNK] Invalid chunk size "${line}"`);
  }
  const size = Number.parseInt(hexPart, 16);
  if (!Number.isSafeInteger(size)) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_CHUNK] Chunk size overflow "${hexPart}"`,
    );
  }
  return size;
}

/** Whether `raw` contains one complete chunked body (terminating zero chunk seen). */
function chunkedBodyComplete(raw: Uint8Array): boolean {
  let offset = 0;
  while (offset < raw.byteLength) {
    const lineEnd = findCrlf(raw, offset);
    if (lineEnd === -1) return false;
    const size = parseChunkSize(
      TEXT_DECODER.decode(raw.subarray(offset, lineEnd)),
    );
    offset = lineEnd + 2;
    if (size === 0) return true;
    if (offset + size + 2 > raw.byteLength) return false;
    if (raw[offset + size] !== 0x0d || raw[offset + size + 1] !== 0x0a) {
      throw new Error(
        "[ERR_RAW_TCP_INVALID_CHUNK] Missing CRLF after chunk payload",
      );
    }
    offset += size + 2;
  }
  return false;
}

export function decodeChunkedBody(raw: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let offset = 0;

  while (offset < raw.byteLength) {
    const lineEnd = findCrlf(raw, offset);
    if (lineEnd === -1) {
      throw new Error(
        "[ERR_RAW_TCP_INVALID_CHUNK] Unterminated chunk size line",
      );
    }

    const size = parseChunkSize(
      TEXT_DECODER.decode(raw.subarray(offset, lineEnd)),
    );
    offset = lineEnd + 2;
    if (size === 0) {
      const merged = new Uint8Array(totalLength);
      let cursor = 0;
      for (const chunk of chunks) {
        merged.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
      return merged;
    }

    if (offset + size + 2 > raw.byteLength) {
      throw new Error("[ERR_RAW_TCP_INVALID_CHUNK] Truncated chunk payload");
    }
    if (raw[offset + size] !== 0x0d || raw[offset + size + 1] !== 0x0a) {
      throw new Error(
        "[ERR_RAW_TCP_INVALID_CHUNK] Missing CRLF after chunk payload",
      );
    }

    chunks.push(raw.subarray(offset, offset + size));
    totalLength += size;
    offset += size + 2;
  }

  throw new Error(
    "[ERR_RAW_TCP_INVALID_CHUNK] Missing terminating zero-length chunk",
  );
}

function indexOfSubarray(
  haystack: Uint8Array,
  needle: Uint8Array,
  from = 0,
): number {
  const limit = haystack.length - needle.length;
  outer: for (let i = from; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function responseFromHead(
  bytes: Uint8Array,
  headerEnd: number,
  head: ParsedResponseHead,
  includeBody: boolean,
): RawTcpResponse {
  const rawHead = TEXT_DECODER.decode(bytes.subarray(0, headerEnd));
  const rawBody =
    headerEnd === -1 ? new Uint8Array(0) : bytes.subarray(headerEnd + 4);
  const body =
    !includeBody || head.framing === "none"
      ? new Uint8Array(0)
      : head.framing === "chunked"
        ? decodeChunkedBody(rawBody)
        : head.framing === "content-length"
          ? rawBody.subarray(0, head.contentLength ?? 0)
          : rawBody;

  return {
    version: head.version,
    status: head.status,
    statusText: head.reason,
    loc: head.headers["location"]?.[0] ?? null,
    headers: new Map(Object.entries(head.headers)),
    rawHead,
    body,
    framing: head.framing,
    contentLength: head.contentLength,
  };
}

function toResponse(bytes: Uint8Array, includeBody = true): RawTcpResponse {
  const headerEnd = indexOfSubarray(bytes, HEADER_END);
  const headBytes = headerEnd === -1 ? bytes : bytes.subarray(0, headerEnd);
  return responseFromHead(
    bytes,
    headerEnd,
    parseResponseHead(headBytes),
    includeBody,
  );
}

export async function rawTcp(
  rawTarget: string,
  options: RawTcpOptions,
): Promise<RawTcpResponse> {
  const {
    port,
    hostname = "127.0.0.1",
    method = "GET",
    headers = {},
    body,
    timeoutMs = 5_000,
    maxBytes = 1024 * 1024,
    readBody = false,
    defaultPort = 80,
    connection = "close",
  } = options;

  const bodyBytes =
    body === undefined
      ? null
      : typeof body === "string"
        ? TEXT_ENCODER.encode(body)
        : body;

  const payload = buildRequestPayload(
    rawTarget,
    method,
    hostname,
    port,
    headers,
    bodyBytes,
    { defaultPort, connection },
  );

  return new Promise<RawTcpResponse>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let written = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let activeSocket: RawTcpSocket | null = null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      fn();
    };

    const fail = (code: string, message: string, cause?: unknown): void => {
      activeSocket?.terminate();
      finish(() => {
        reject(
          new Error(
            `[${code}] ${message}`,
            cause === undefined ? undefined : { cause },
          ),
        );
      });
    };

    const flushWrite = (socket: RawTcpSocket): void => {
      while (written < payload.byteLength) {
        const sent = socket.write(payload.subarray(written));
        if (sent === 0) return;
        written += sent;
      }
    };

    const concat = (): Uint8Array => {
      if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);
      const out = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    };

    timer = setTimeout(() => {
      fail(
        "ERR_RAW_TCP_TIMEOUT",
        `Timed out after ${timeoutMs}ms (${method} ${rawTarget})`,
      );
    }, timeoutMs);

    Bun.connect({
      hostname,
      port,
      socket: {
        open(socket) {
          activeSocket = socket;
          flushWrite(socket);
        },
        drain(socket) {
          flushWrite(socket);
        },
        data(socket, chunk) {
          if (settled) return;
          totalBytes += chunk.byteLength;
          if (totalBytes > maxBytes) {
            fail("ERR_RAW_TCP_OVERFLOW", `Response exceeded ${maxBytes} bytes`);
            return;
          }
          chunks.push(new Uint8Array(chunk));

          const combined = concat();
          const headerEnd = indexOfSubarray(combined, HEADER_END);
          if (headerEnd === -1) return;

          if (!readBody) {
            socket.terminate();
            try {
              finish(() => resolve(toResponse(combined, false)));
            } catch (error) {
              fail(
                "ERR_RAW_TCP_INVALID_RESPONSE",
                error instanceof Error ? error.message : String(error),
                error,
              );
            }
            return;
          }

          let head: ParsedResponseHead;
          try {
            head = parseResponseHead(combined.subarray(0, headerEnd));
          } catch (error) {
            fail(
              "ERR_RAW_TCP_INVALID_RESPONSE",
              error instanceof Error ? error.message : String(error),
              error,
            );
            return;
          }

          const rawBody = combined.subarray(headerEnd + 4);
          const complete =
            head.framing === "none" || method === "HEAD"
              ? true
              : head.framing === "content-length"
                ? rawBody.byteLength >= (head.contentLength ?? 0)
                : head.framing === "chunked"
                  ? chunkedBodyComplete(rawBody)
                  : false;
          if (!complete) return;

          socket.terminate();
          try {
            finish(() =>
              resolve(
                responseFromHead(
                  combined,
                  headerEnd,
                  head,
                  readBody && method !== "HEAD",
                ),
              ),
            );
          } catch (error) {
            fail(
              "ERR_RAW_TCP_INVALID_RESPONSE",
              error instanceof Error ? error.message : String(error),
              error,
            );
          }
        },
        close() {
          if (settled) return;
          try {
            finish(() => resolve(toResponse(concat())));
          } catch (error) {
            fail(
              "ERR_RAW_TCP_INVALID_RESPONSE",
              error instanceof Error ? error.message : String(error),
              error,
            );
          }
        },
        error(_socket, error) {
          fail("ERR_RAW_TCP_SOCKET", error.message, error);
        },
        connectError(_socket, error) {
          fail("ERR_RAW_TCP_CONNECT", error.message, error);
        },
      },
    }).catch((error: unknown) => {
      fail("ERR_RAW_TCP_CONNECT", String(error), error);
    });
  });
}
