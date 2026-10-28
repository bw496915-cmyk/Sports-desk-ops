# Bun HTTP Server, WebSocket Handler & TLS Runtime Shapes Specification

This runbook defines the runtime contracts, TypeScript interface shapes, lifecycle mechanics, and architectural trade-offs for the native **Bun (v1.4+) HTTP Server**, **WebSocket Handler**, and **TLS Options** within the SportsDesk and Fantasy402 operational suite.

---

## 1. Architectural Overview & Design Rationales

SportsDesk leverages Bun's native C++ HTTP and WebSocket engine (built on top of `uWebSockets` and `BoringSSL`) rather than Node.js `http` or third-party frameworks. To build robust, high-frequency surveillance tools, live ticker streaming pipelines, and secure Telegram Mini App gateways, all server components adhere to three canonical runtime interfaces:

1. **`interface Server extends Disposable`**: The running server instance managing socket lifecycles, hot reloads, client IP resolution, in-memory routing, and kernel-level WebSocket pub/sub.
2. **`interface WebSocketHandler<T = undefined>`**: The bidirectional streaming contract handling per-socket state, backpressure relief, automated ping/pong frames, and topic multiplexing.
3. **`interface TLSOptions`**: The transport encryption specification configuring certificate chains, private keys, ALPN negotiation, and memory tuning.

---

## 2. Interface Shape 1: `Server extends Disposable`

The `Server` interface represents a running HTTP and WebSocket listener spawned via `Bun.serve()`. It extends the ECMAScript Explicit Resource Management `Disposable` contract (`Symbol.dispose`).

### 2.1 Complete TypeScript Declaration

```typescript
export interface Server extends Disposable {
  /**
   * Stop the server from accepting new connections.
   * @param closeActiveConnections If true, immediately terminates all connections (WebSockets close with code 1001)
   * @returns Promise that resolves when the server has stopped
   */
  stop(closeActiveConnections?: boolean): Promise<void>;

  /**
   * Close idle keep-alive connections without stopping the server.
   * @returns The number of connections closed
   */
  closeIdleConnections(): number;

  /**
   * Update handlers without restarting the server.
   * Only fetch, error, routes, and websocket can be updated.
   */
  reload(options: Serve.Options<undefined>): Server;

  /**
   * Make a request to the running server in-memory.
   * Evaluates the fetch handler directly without binding network ports or making TCP syscalls.
   */
  fetch(request: Request | string): Response | Promise<Response>;

  /**
   * Upgrade an HTTP request to a WebSocket connection.
   * @returns true if upgrade successful, false if failed
   */
  upgrade<T = undefined>(
    request: Request,
    options?: {
      headers?: Bun.HeadersInit;
      data?: T;
    },
  ): boolean;

  /**
   * Publish a message to all WebSocket clients subscribed to a topic.
   * @param compress Defaults to true, unlike ws.send() and ws.publish(). Only applies to clients that negotiated perMessageDeflate
   * @returns Bytes sent, 0 if dropped, -1 if backpressure applied
   */
  publish(
    topic: string,
    data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer | Blob,
    compress?: boolean,
  ): ServerWebSocketSendStatus;

  /**
   * Get count of WebSocket clients subscribed to a topic.
   */
  subscriberCount(topic: string): number;

  /**
   * Get client IP address and port from the underlying socket.
   * @returns null for closed requests or Unix domain sockets
   */
  requestIP(request: Request): SocketAddress | null;

  /**
   * Set custom idle timeout for a request.
   * @param seconds Timeout in seconds, 0 to disable
   */
  timeout(request: Request, seconds: number): void;

  /**
   * Keep process alive while server is running.
   */
  ref(): void;

  /**
   * Allow process to exit if server is the only thing running on the event loop.
   */
  unref(): void;

  /** Number of in-flight HTTP requests */
  readonly pendingRequests: number;

  /** Number of active WebSocket connections */
  readonly pendingWebSockets: number;

  /** Server URL including protocol, hostname, and port */
  readonly url: URL;

  /** Listening port number */
  readonly port: number;

  /** Bound hostname or IP address */
  readonly hostname: string;

  /** Whether development mode is active */
  readonly development: boolean;

  /** Unique server instance identifier */
  readonly id: string;
}
```

### 2.2 Operational Mechanics & Method Invariants

#### 1. In-Memory Request Dispatching (`server.fetch`)

- **Direct Evaluation**: `server.fetch(request)` runs the server's registered routing pipeline directly in memory without initiating TCP handshakes or binding OS network ports.
- **CI / Testing Advantage**: In sandboxed environments or automated test runners where port binding (`listen(2)`) is restricted or prone to `EADDRINUSE` conflicts, test suites invoke `server.fetch(new Request("http://localhost/health"))` with zero socket allocation overhead.
- **Microsecond Latency**: Bypasses loopback IP stack encapsulation, evaluating responses in sub-microsecond intervals.

#### 2. Resource Management & Explicit Scope Disposal (`Disposable`)

- Implements `[Symbol.dispose]()`. In modern TypeScript/Bun runtimes using ECMAScript Explicit Resource Management:
  ```typescript
  {
    using server = Bun.serve({ fetch: handler });
    // Server is automatically stopped when scope exits via Symbol.dispose
  }
  ```
- `server.stop(true)` sends WebSocket close code `1001` (`Going Away`) across all active sockets and drains outstanding requests.

#### 3. Zero-Downtime Hot Handler Reloading (`server.reload`)

- Allows dynamic live-updating of `fetch`, `error`, `routes`, and `websocket` configurations without restarting the process or dropping active keep-alive HTTP or WebSocket connections.
- Used in SportsDesk daemons to reconfigure risk route thresholds or refresh Mini App templates on the fly.

#### 4. Socket Address & Syndicate Correlation (`server.requestIP`)

- Resolves `SocketAddress`:
  ```typescript
  export interface SocketAddress {
    readonly address: string;
    readonly port: number;
    readonly family: "IPv4" | "IPv6";
  }
  ```
- **Syndicate Correlation**: When running directly or behind a transparent proxy with `X-Forwarded-For` verification, `requestIP` provides the raw peer socket IP. SportsDesk uses this to correlate sharp sub-accounts wagering from identical `/24` CIDR blocks within sub-second intervals.

#### 5. Event Loop Steering (`ref()` vs `unref()`)

- By default, `Bun.serve()` calls `ref()`, keeping the Bun process alive indefinitely.
- Calling `server.unref()` permits background reporting daemons or CLI commands to serve transient health probes or webhooks while allowing the process to terminate naturally when batch workloads complete.

---

## 3. Interface Shape 2: `WebSocketHandler<T = undefined>`

The `WebSocketHandler<T>` interface defines the hooks and operational policies for full-duplex WebSocket connections upgraded via `server.upgrade(req, { data: sessionContext })`.

### 3.1 Complete TypeScript Declaration

```typescript
export interface WebSocketHandler<T = undefined> {
  /**
   * Called when a connection is opened.
   */
  open?(ws: ServerWebSocket<T>): void | Promise<void>;

  /**
   * Called when a message is received.
   */
  message(
    ws: ServerWebSocket<T>,
    message: string | Buffer,
  ): void | Promise<void>;

  /**
   * Called when a connection is closed.
   */
  close?(
    ws: ServerWebSocket<T>,
    code: number,
    reason: string,
  ): void | Promise<void>;

  /**
   * Called when the write buffer is drained after reaching backpressure limit.
   */
  drain?(ws: ServerWebSocket<T>): void | Promise<void>;

  /**
   * Called when an uncaught error occurs on the WebSocket connection.
   */
  error?(ws: ServerWebSocket<T>, error: Error): void | Promise<void>;

  /**
   * Enable per-message deflate compression.
   * @default false
   */
  perMessageDeflate?:
    | boolean
    | {
        compress?: boolean;
        decompress?: boolean;
      };

  /**
   * Maximum incoming message payload length in bytes.
   * @default 16777216 (16 MB)
   */
  maxPayloadLength?: number;

  /**
   * Inactivity timeout in seconds before closing the connection.
   * @default 120
   */
  idleTimeout?: number;

  /**
   * Maximum backpressure buffer in bytes before ws.send() returns -1 or drops.
   * @default 16777216 (16 MB)
   */
  backpressureLimit?: number;

  /**
   * Automatically send ping frames to client every idleTimeout / 2 seconds.
   * @default true
   */
  sendPings?: boolean;

  /**
   * Whether server.publish() sends messages to the socket that initiated the publish.
   * @default false
   */
  publishToSelf?: boolean;
}
```

### 3.2 Operational Mechanics & Stream Invariants

#### 1. Per-Socket Generic Session Context (`T`)

- When upgrading a connection in HTTP `fetch`:
  ```typescript
  server.upgrade(request, {
    data: {
      accountIdentifier: "MM800",
      agentIdentifier: "CUB22HR",
      subscribedChannels: ["L22.N1402", "L23.N0412"],
      connectedAtMs: Date.now(),
    } satisfies TickerSessionContext,
  });
  ```
- The context object is strongly typed on `ws.data` across all callbacks (`open`, `message`, `drain`, `close`).

#### 2. Kernel Pub/Sub Topic Multiplexing

- Instead of manually iterating through an array of WebSocket client sockets in JavaScript memory:
  ```typescript
  ws.subscribe("ticker:steam");
  ws.subscribe("alerts:syndicate");
  ```
- Broadcasters call `server.publish("ticker:steam", payload)`. The message is broadcasted down in native C++ memory directly to all subscribed sockets with zero intermediate V8/JSC array allocations.

#### 3. Backpressure Protection & The `drain()` Hook

- High-velocity bet streams (e.g., live whale sizing anomalies on `L23.N0412`) can overwhelm slow mobile clients connected via Telegram Mini Apps.
- When the socket's internal write buffer exceeds `backpressureLimit` (default 16 MB), `ws.send()` returns `-1` (backpressure applied) or `0` (dropped).
- The `drain(ws)` hook is triggered once the operating system drains the socket buffer back below safety thresholds, allowing resumption of pending ticket streams without memory exhaustion.

#### 4. Automated Keep-Alives (`sendPings: true`)

- Bun automatically handles RFC 6455 Ping/Pong frame heartbeats without user-space timers. Sockets that fail to respond within `idleTimeout` are cleanly dropped with code `1006` or `1001`.

---

## 4. Interface Shape 3: `TLSOptions`

The `TLSOptions` interface configures TLS termination inside `Bun.serve({ tls: { ... } })`.

### 4.1 Complete TypeScript Declaration

```typescript
export interface TLSOptions {
  /**
   * Path to private key file, or raw Buffer / string containing PEM key.
   * Supports arrays for multiple certificates (SNI).
   */
  key?: string | Buffer | BunFile | Array<string | Buffer | BunFile>;

  /**
   * Path to certificate file, or raw Buffer / string containing PEM cert chain.
   * Supports arrays for multiple certificates (SNI).
   */
  cert?: string | Buffer | BunFile | Array<string | Buffer | BunFile>;

  /**
   * Path to CA certificate file, or raw Buffer / string containing PEM CA.
   */
  ca?: string | Buffer | BunFile | Array<string | Buffer | BunFile>;

  /**
   * Passphrase for encrypted private key.
   */
  passphrase?: string;

  /**
   * Path to Diffie-Hellman parameters file.
   */
  dhParamsFile?: string;

  /**
   * Default server name for Server Name Indication (SNI).
   */
  serverName?: string;

  /**
   * Reduce memory usage at the cost of performance.
   * @default false
   */
  lowMemoryMode?: boolean;
}
```

---

## 5. Architectural Evaluation: Standalone Bun TLS vs Edge Nginx Reverse Proxy

A critical design decision in SportsDesk is **where** TLS termination occurs:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ OPTION A: Standalone Bun TLS Termination                                    │
│                                                                             │
│ Client (HTTPS 443) ──► [ Bun.serve({ tls }) ]                               │
│                        ├── User-Space OpenSSL / BoringSSL Encryption        │
│                        └── ❌ Zero-Copy sendfile(2) DISABLED                 │
│                            (File bytes copied: Disk -> Kernel -> User -> TLS│
│                             -> Kernel -> NIC)                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ OPTION B: Edge Nginx Reverse Proxy (SportsDesk Production Standard)         │
│                                                                             │
│ Client (HTTPS 443) ──► [ Nginx (Edge TLS 1.3 / Let's Encrypt) ]             │
│                                │                                            │
│                        Unencrypted HTTP/1.1 Loopback (127.0.0.1:4020)       │
│                                ▼                                            │
│                        [ Bun.serve({ port: 4020 }) ]                        │
│                        ├── Plaintext HTTP Loopback Socket                   │
│                        └── ✅ Zero-Copy sendfile(2) ACTIVE                   │
│                            (File bytes streamed directly via kernel cache)  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 The Zero-Copy Precondition

- Native zero-copy streaming (`new Response(Bun.file(path))`) relies on the OS `sendfile(2)` syscall.
- `sendfile(2)` transfers file data directly from the OS page cache to the network socket descriptor within kernel space.
- **Why Standalone TLS Disables Zero-Copy**: In TLS sockets, payload bytes must be encrypted before transmission. Because the kernel cannot encrypt payload bytes with user-space TLS keys directly in the standard `sendfile` path, the runtime must read disk bytes into user space memory, encrypt them, and write the encrypted ciphertext back to the socket.
- **SportsDesk Benchmark Evidence**:
  - Unencrypted `Bun.file` lazy handle response: **0.46 µs** (measured in `tests/bench_server.test.ts`).
  - Memory-buffered `readFileSync` + stringify: **45.66 µs** (99.94x slower).

### 5.2 Why SportsDesk Chooses Option B

1. **Preserves Zero-Copy File Transfers**: High-frequency dashboard delivery (`customer-churn-simulation-dashboard.html` and `telegram-miniapp-dashboard.html`) operates at maximum kernel throughput over loopback.
2. **Standardized Edge Security**: Nginx manages rate-limiting, DDoS mitigation, and automatic Let's Encrypt renewal (`certbot`) without restarting or redeploying the Bun application.
3. **When Standalone Bun TLS is Appropriate**: Standalone `TLSOptions` is reserved for internal microservice-to-microservice mutual TLS (mTLS) across private VPC boundaries where no edge reverse proxy exists.

---

## 6. SportsDesk Production Server Alignment Matrix

| Interface / Feature            | SportsDesk Implementation Module                           | Operational Policy & Configuration                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Port Cascade**               | `sportsdesk_webview_server.ts`                             | Resolves via `BUN_PORT` → `PORT` → `NODE_PORT` → `3000`. Production defaults to `PORT=4020` in `.env`.                                                               |
| **Hostname Binding**           | `sportsdesk_webview_server.ts`                             | Default `0.0.0.0` (all interfaces), configurable to `127.0.0.1` for strict loopback.                                                                                 |
| **Error Boundary**             | `sportsdesk_webview_server.ts`                             | Implements `error(err)` hook returning structured 500 JSON, suppressing stack traces when `NODE_ENV=production`.                                                     |
| **Security Headers**           | `sportsdesk_webview_server.ts`                             | Omits deprecated `X-Frame-Options: ALLOWALL`; enforces `Content-Security-Policy: frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;`. |
| **In-Memory Testing**          | `tests/server_error.test.ts`, `tests/bench_server.test.ts` | Evaluates routes via `server.fetch(req)` to eliminate port contention in sandboxes and CI.                                                                           |
| **WebSocket Ticker (Roadmap)** | `fantasy402-ticker-watch`                                  | Implements `WebSocketHandler<TickerSessionContext>` with `perMessageDeflate: true`, `backpressureLimit: 16MB`, and topic pub/sub (`ticker:steam`, `ticker:whale`).   |
| **TLS Policy**                 | `deploy_to_vps.sh`                                         | Nginx terminates TLS 1.3 at port 443; Bun listens on plaintext HTTP loopback `127.0.0.1:4020` to preserve zero-copy kernel streaming.                                |
