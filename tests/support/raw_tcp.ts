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

  const headerLines = [
    `${method} ${rawTarget} HTTP/1.1`,
    `Host: ${hostname}:${port}`,
    "Connection: close",
  ];
  for (const [key, value] of Object.entries(headers)) {
    headerLines.push(`${key}: ${value}`);
  }
  const hasContentLength = Object.keys(headers).some(
    (key) => key.toLowerCase() === "content-length",
  );
  if (bodyBytes !== null && !hasContentLength) {
    headerLines.push(`Content-Length: ${bodyBytes.byteLength}`);
  }

  const headPayload = encoder.encode(`${headerLines.join("\r\n")}\r\n\r\n`);
  const payload = new Uint8Array(
    headPayload.byteLength + (bodyBytes?.byteLength ?? 0),
  );
  payload.set(headPayload, 0);
  if (bodyBytes !== null) payload.set(bodyBytes, headPayload.byteLength);

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
