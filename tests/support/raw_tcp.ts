/**
 * @file tests/support/raw_tcp.ts
 * @description Minimal HTTP/1.1-over-TCP client for wire-level tests. `fetch`
 * normalizes methods, headers and bodies; these tests need the actual status
 * line, header casing and empty-304 body.
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
}

export interface RawTcpResponse {
  readonly version: string;
  readonly status: number;
  readonly statusText: string;
  readonly loc: string | null;
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly rawHead: string;
  readonly body: Uint8Array;
}

const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type RawTcpSocket = Awaited<ReturnType<typeof Bun.connect>>;

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

function parseResponse(bytes: Uint8Array): RawTcpResponse {
  const splitIdx = indexOfSubarray(bytes, HEADER_END);
  const headBytes = splitIdx === -1 ? bytes : bytes.subarray(0, splitIdx);
  const body =
    splitIdx === -1 ? new Uint8Array(0) : bytes.subarray(splitIdx + 4);
  const rawHead = decoder.decode(headBytes);
  const lines = rawHead.split("\r\n");

  const statusLine = lines[0] ?? "";
  const match = /^(HTTP\/\d+\.\d+)\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  const status = match ? Number(match[2]) : -1;

  const headers = new Map<string, string[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const list = headers.get(key);
    if (list !== undefined) list.push(value);
    else headers.set(key, [value]);
  }

  return {
    version: match?.[1] ?? "",
    status,
    statusText: match?.[3] ?? "",
    loc: headers.get("location")?.[0] ?? null,
    headers,
    rawHead,
    body,
  };
}

const CRLF_RE = /[\r\n]/;
const CTL_OR_SPACE_RE = /[\x00-\x20\x7f]/;
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 9110 field-vchar + SP/HTAB, excluding NUL, CTLs 0x01-0x08/0x0a-0x1f and DEL 0x7f.
const OBS_FOLD_OR_CTL_RE = /[\x00-\x08\x0a-\x1f\x7f]/;

function assertNoCrlf(value: string, label: string): void {
  if (CRLF_RE.test(value)) {
    throw new Error(`[ERR_RAW_TCP_INVALID_HEADER] CR/LF forbidden in ${label}`);
  }
}

function formatHostHeader(hostname: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[ERR_RAW_TCP_INVALID_PORT] Invalid TCP port ${port}`);
  }
  const normalizedHost = hostname.trim();
  if (normalizedHost.length === 0 || CTL_OR_SPACE_RE.test(normalizedHost)) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_HEADER] Invalid hostname "${hostname}"`,
    );
  }
  const host =
    normalizedHost.includes(":") && !normalizedHost.startsWith("[")
      ? `[${normalizedHost}]`
      : normalizedHost;
  return port === 80 ? host : `${host}:${port}`;
}

/**
 * Build the request head and optional body. Caller-controlled lines are
 * validated as HTTP tokens/values, so a test header cannot smuggle a second
 * request or a malformed method/target.
 */
export function buildRequestPayload(
  rawTarget: string,
  method: string,
  hostname: string,
  port: number,
  headers: Readonly<Record<string, string>>,
  bodyBytes: Uint8Array | null,
): Uint8Array {
  assertNoCrlf(method, "method");
  assertNoCrlf(rawTarget, "rawTarget");
  if (!TOKEN_RE.test(method)) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_METHOD] Invalid HTTP method "${method}"`,
    );
  }
  if (rawTarget.length === 0 || CTL_OR_SPACE_RE.test(rawTarget)) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_TARGET] Invalid request target "${rawTarget}"`,
    );
  }

  const seenLower = new Set<string>();
  const customLines: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    assertNoCrlf(rawKey, "header key");
    assertNoCrlf(rawValue, `header value for "${rawKey}"`);
    if (OBS_FOLD_OR_CTL_RE.test(rawValue)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Control character forbidden in header value for "${rawKey}"`,
      );
    }
    if (rawKey.trim() === "") {
      throw new Error("[ERR_RAW_TCP_INVALID_HEADER] empty header name");
    }
    if (!TOKEN_RE.test(rawKey.trim())) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid header name "${rawKey}"`,
      );
    }
    const key = rawKey.trim();
    const lower = key.toLowerCase();
    // Deduplicate case-insensitively: keep the first occurrence so a caller
    // cannot send two Host/Content-Length fields with conflicting values.
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    customLines.push(`${key}: ${rawValue.trim()}`);
  }

  const lines = [`${method} ${rawTarget} HTTP/1.1`];

  if (!seenLower.has("host")) {
    const hostValue = formatHostHeader(hostname, port);
    assertNoCrlf(hostValue, "Host");
    lines.push(`Host: ${hostValue}`);
  }

  if (!seenLower.has("connection")) {
    lines.push("Connection: close");
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

  const headPayload = encoder.encode(`${lines.join("\r\n")}\r\n\r\n`);
  if (bodyBytes === null) return headPayload;

  const out = new Uint8Array(headPayload.byteLength + bodyBytes.byteLength);
  out.set(headPayload, 0);
  out.set(bodyBytes, headPayload.byteLength);
  return out;
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
  } = options;

  const bodyBytes =
    body === undefined
      ? null
      : typeof body === "string"
        ? encoder.encode(body)
        : body;

  const payload = buildRequestPayload(
    rawTarget,
    method,
    hostname,
    port,
    headers,
    bodyBytes,
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

          if (!readBody) {
            const combined = concat();
            if (indexOfSubarray(combined, HEADER_END) !== -1) {
              socket.terminate();
              finish(() => resolve(parseResponse(combined)));
            }
          }
        },
        close() {
          finish(() => resolve(parseResponse(concat())));
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
