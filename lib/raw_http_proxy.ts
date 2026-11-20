/**
 * @file raw_http_proxy.ts
 * @description Bounded reverse proxy for Bun.serve: forwards HTTP requests and
 * WebSocket upgrades to one fixed upstream. WebSocket flow control uses Bun's
 * inbound `pause()` correctly (stop reading from the client while the upstream
 * send buffer is full) and an outbound queue flushed by `drain()` when the
 * client send buffer is full.
 */

import type { Server, ServerWebSocket, WebSocketOptions } from "bun";

export interface RawHttpProxyOptions {
  readonly hostname: string;
  readonly port: number;
  readonly tls?: boolean;
  readonly timeoutMs?: number;
  readonly maxRequestBodyBytes?: number;
  readonly maxResponseBodyBytes?: number;
  readonly maxWebSocketMessageBytes?: number;
  /** Pause client reads once the upstream send buffer is this full. */
  readonly webSocketHighWaterBytes?: number;
  /** Queue this much client-bound data while the client send buffer is full. */
  readonly maxWebSocketQueueBytes?: number;
  /** Forward the client address as a fresh X-Forwarded-For (default false). */
  readonly forwardClientIp?: boolean;
  /**
   * Outbound WebSocket client options: TLS (`ca`, client certs), an HTTP
   * proxy (including `proxy.tls` for HTTPS proxies) and `perMessageDeflate`.
   * `headers` is omitted because the proxy forwards the inbound request's
   * headers itself.
   */
  readonly webSocketOptions?: Omit<WebSocketOptions, "headers">;
}

export interface ProxySession {
  readonly upstream: WebSocket;
  readonly queue: Array<string | ArrayBuffer>;
  queuedBytes: number;
  client: ServerWebSocket<ProxySession> | null;
  closed: boolean;
  paused: boolean;
  pauseTimer: ReturnType<typeof setInterval> | null;
}

export interface RawHttpProxy {
  readonly fetch: (
    req: Request,
    server: Server<ProxySession>,
  ) => Promise<Response | undefined>;
  readonly websocket: {
    open(ws: ServerWebSocket<ProxySession>): void;
    message(ws: ServerWebSocket<ProxySession>, message: string | Buffer): void;
    drain(ws: ServerWebSocket<ProxySession>): void;
    close(
      ws: ServerWebSocket<ProxySession>,
      code: number,
      reason: string,
    ): void;
    error(error: Error, ws: ServerWebSocket<ProxySession>): void;
  };
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const WEBSOCKET_HEADERS = new Set([
  "host",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-websocket-accept",
]);

class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

function connectionTokens(headers: Headers): ReadonlySet<string> {
  const value = headers.get("connection");
  if (value === null) return new Set();
  return new Set(
    value
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function forwardedHeaders(
  req: Request,
  clientAddress: string | null,
  forwardClientIp: boolean,
  websocket: boolean,
): Headers {
  const connection = connectionTokens(req.headers);
  const out = new Headers();
  req.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connection.has(lower)) return;
    if (websocket && WEBSOCKET_HEADERS.has(lower)) return;
    if (!websocket && (lower === "host" || lower === "content-length")) return;
    out.set(name, value);
  });
  if (forwardClientIp && clientAddress !== null) {
    out.set("x-forwarded-for", clientAddress);
  } else {
    out.delete("x-forwarded-for");
  }
  if (!websocket) out.set("accept-encoding", "identity");
  return out;
}

function upstreamUrl(
  req: Request,
  hostname: string,
  port: number,
  tls: boolean,
): URL {
  const path = new URL(req.url);
  return new URL(
    `${tls ? "wss" : "ws"}://${hostname}:${port}${path.pathname}${path.search}`,
  );
}

function httpUpstreamUrl(
  req: Request,
  hostname: string,
  port: number,
  tls: boolean,
): URL {
  const path = new URL(req.url);
  return new URL(
    `${tls ? "https" : "http"}://${hostname}:${port}${path.pathname}${path.search}`,
  );
}

async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLargeStatus: 413 | 502,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (body === null) return null;
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ProxyError(
          tooLargeStatus,
          tooLargeStatus === 413
            ? "Request body too large"
            : "Upstream response too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function closeCode(code: number): number {
  // 1005/1006/1015 are local-only; never send them as a Close frame code.
  if (code === 1005) return 1000;
  if (code === 1006 || code === 1015) return 1011;
  if (
    code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1014)
  ) {
    return code;
  }
  return 1000;
}

function pauseWhileUpstreamBuffers(
  ws: ServerWebSocket<ProxySession>,
  session: ProxySession,
  highWaterBytes: number,
): void {
  if (session.paused || session.closed) return;
  if (session.upstream.bufferedAmount <= highWaterBytes) return;
  session.paused = true;
  ws.pause();
  const check = setInterval(() => {
    if (session.closed || session.client === null) {
      clearInterval(check);
      return;
    }
    if (session.upstream.bufferedAmount <= highWaterBytes / 2) {
      clearInterval(check);
      session.pauseTimer = null;
      session.paused = false;
      if (!session.closed) session.client.resume();
    }
  }, 10);
  session.pauseTimer = check;
}

function queueForClient(
  session: ProxySession,
  ws: ServerWebSocket<ProxySession> | null,
  data: string | ArrayBuffer,
  maxQueueBytes: number,
): boolean {
  if (ws !== null && ws.send(data) > 0) return true;
  const bytes =
    typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  if (session.queuedBytes + bytes > maxQueueBytes) return false;
  session.queue.push(data);
  session.queuedBytes += bytes;
  return true;
}

function flushQueue(
  session: ProxySession,
  ws: ServerWebSocket<ProxySession>,
): void {
  while (session.queue.length > 0) {
    const next = session.queue[0];
    if (next === undefined) return;
    const status = ws.send(next);
    if (status <= 0) return;
    session.queue.shift();
    session.queuedBytes -=
      typeof next === "string" ? Buffer.byteLength(next) : next.byteLength;
  }
}

function stopPause(session: ProxySession): void {
  if (session.pauseTimer !== null) {
    clearInterval(session.pauseTimer);
    session.pauseTimer = null;
  }
  session.paused = false;
}

function closeSession(
  session: ProxySession,
  ws: ServerWebSocket<ProxySession> | null,
  code: number,
  reason: string,
): void {
  if (session.closed) return;
  session.closed = true;
  stopPause(session);
  try {
    if (session.upstream.readyState === WebSocket.OPEN) {
      session.upstream.close(closeCode(code), reason.slice(0, 120));
    }
  } catch {
    // The upstream may already be closing.
  }
  if (ws !== null && ws.readyState === WebSocket.OPEN) {
    try {
      ws.close(closeCode(code), reason.slice(0, 120));
    } catch {
      // The client may already be closing.
    }
  }
}

function waitForOpen(upstream: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer);
      upstream.removeEventListener("open", onOpen);
      upstream.removeEventListener("error", onError);
      upstream.removeEventListener("close", onClose);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new ProxyError(502, "Upstream WebSocket handshake failed"));
    };
    const onClose = (): void => {
      cleanup();
      reject(new ProxyError(502, "Upstream WebSocket closed during handshake"));
    };
    timer = setTimeout(() => {
      cleanup();
      upstream.close();
      reject(new ProxyError(504, "Upstream WebSocket handshake timed out"));
    }, timeoutMs);
    upstream.addEventListener("open", onOpen, { once: true });
    upstream.addEventListener("error", onError, { once: true });
    upstream.addEventListener("close", onClose, { once: true });
  });
}

function toMessageData(
  data: string | ArrayBuffer | Blob,
): string | ArrayBuffer {
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  return new ArrayBuffer(0);
}

export function createRawHttpProxy(options: RawHttpProxyOptions): RawHttpProxy {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 1024 * 1024;
  const maxResponseBodyBytes = options.maxResponseBodyBytes ?? 10 * 1024 * 1024;
  const maxWebSocketMessageBytes =
    options.maxWebSocketMessageBytes ?? 1024 * 1024;
  const highWater = options.webSocketHighWaterBytes ?? 64 * 1024;
  const maxQueue = options.maxWebSocketQueueBytes ?? 1024 * 1024;
  const tls = options.tls ?? false;

  async function forwardHttp(
    req: Request,
    clientAddress: string | null,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new ProxyError(504, "Upstream request timed out"));
    }, timeoutMs);
    const abort = (): void => {
      controller.abort(req.signal.reason);
    };
    if (req.signal.aborted) abort();
    else req.signal.addEventListener("abort", abort, { once: true });

    try {
      const body = await readBodyBounded(
        req.body,
        maxRequestBodyBytes,
        413,
        controller.signal,
      );
      const headers = forwardedHeaders(
        req,
        clientAddress,
        options.forwardClientIp ?? false,
        false,
      );
      const response = await fetch(
        httpUpstreamUrl(req, options.hostname, options.port, tls),
        {
          method: req.method,
          headers,
          body:
            body === null || req.method === "GET" || req.method === "HEAD"
              ? undefined
              : body,
          redirect: "manual",
          signal: controller.signal,
        },
      );
      const responseBody =
        req.method === "HEAD" ||
        response.status === 204 ||
        response.status === 304
          ? null
          : await readBodyBounded(
              response.body,
              maxResponseBodyBytes,
              502,
              controller.signal,
            );
      const responseHeaders = new Headers();
      const connection = connectionTokens(response.headers);
      response.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP.has(lower) || connection.has(lower)) return;
        if (lower === "content-length" || lower === "content-encoding") return;
        responseHeaders.append(name, value);
      });
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      if (controller.signal.aborted) {
        if (req.signal.aborted) throw new ProxyError(499, "Client aborted");
        throw new ProxyError(504, "Upstream request timed out");
      }
      throw new ProxyError(502, "Upstream request failed");
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", abort);
    }
  }

  async function upgradeWebSocket(
    req: Request,
    server: Server<ProxySession>,
    clientAddress: string | null,
  ): Promise<Response | undefined> {
    const headers = forwardedHeaders(
      req,
      clientAddress,
      options.forwardClientIp ?? false,
      true,
    );
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter(Boolean);
    if (protocols.length > 0) {
      headers.set("sec-websocket-protocol", protocols.join(", "));
    }
    const url = upstreamUrl(req, options.hostname, options.port, tls);
    const upstreamOptions: WebSocketOptions = {
      ...(options.webSocketOptions ?? {}),
      headers,
    };
    const upstream = new WebSocket(url, upstreamOptions);
    upstream.binaryType = "arraybuffer";

    try {
      await waitForOpen(upstream, timeoutMs);
    } catch (error) {
      upstream.close();
      throw error;
    }

    const session: ProxySession = {
      upstream,
      queue: [],
      queuedBytes: 0,
      client: null,
      closed: false,
      paused: false,
      pauseTimer: null,
    };

    const deliver = (data: string | ArrayBuffer): void => {
      if (!queueForClient(session, session.client, data, maxQueue)) {
        closeSession(session, session.client, 1011, "Proxy queue overflow");
      }
    };

    upstream.addEventListener("message", (event) => {
      const data = event.data;
      const message = typeof data === "string" ? data : toMessageData(data);
      const bytes =
        typeof message === "string"
          ? Buffer.byteLength(message)
          : message.byteLength;
      if (bytes > maxWebSocketMessageBytes) {
        closeSession(session, session.client, 1009, "Message too large");
        return;
      }
      deliver(message);
    });
    upstream.addEventListener("close", (event) => {
      closeSession(session, session.client, event.code, event.reason);
    });
    upstream.addEventListener("error", () => {
      closeSession(session, session.client, 1011, "Upstream WebSocket error");
    });

    const upgradeHeaders: Record<string, string> = {};
    if (upstream.protocol !== "") {
      upgradeHeaders["sec-websocket-protocol"] = upstream.protocol;
    }
    const upgraded = server.upgrade(req, {
      data: session,
      ...(Object.keys(upgradeHeaders).length === 0
        ? {}
        : { headers: upgradeHeaders }),
    });
    if (!upgraded) {
      closeSession(session, null, 1000, "Client upgrade failed");
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return undefined;
  }

  return {
    async fetch(req, server) {
      const clientAddress = server.requestIP(req)?.address ?? null;
      try {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return await upgradeWebSocket(req, server, clientAddress);
        }
        return await forwardHttp(req, clientAddress);
      } catch (error) {
        if (error instanceof ProxyError) {
          return new Response(error.message, { status: error.status });
        }
        return new Response("Bad Gateway", { status: 502 });
      }
    },
    websocket: {
      open(ws) {
        ws.data.client = ws;
        if (ws.data.closed) {
          ws.close(1000, "Upstream already closed");
          return;
        }
        flushQueue(ws.data, ws);
      },
      message(ws, message) {
        if (ws.data.closed) return;
        const bytes =
          typeof message === "string"
            ? Buffer.byteLength(message)
            : message.byteLength;
        if (bytes > maxWebSocketMessageBytes) {
          closeSession(ws.data, ws, 1009, "Message too large");
          return;
        }
        if (ws.data.upstream.readyState !== WebSocket.OPEN) {
          closeSession(ws.data, ws, 1011, "Upstream not open");
          return;
        }
        try {
          ws.data.upstream.send(message);
          pauseWhileUpstreamBuffers(ws, ws.data, highWater);
        } catch {
          closeSession(ws.data, ws, 1011, "Upstream send failed");
        }
      },
      drain(ws) {
        flushQueue(ws.data, ws);
      },
      close(ws, code, reason) {
        closeSession(ws.data, null, code, reason);
      },
      error(_error, ws) {
        closeSession(ws.data, ws, 1011, "Client WebSocket error");
      },
    },
  };
}
