/**
 * @file tests/raw_http_proxy.test.ts
 * @description Integration tests for createRawHttpProxy against a local
 * upstream: HTTP forwarding, hop-by-hop stripping, response limits, and a
 * WebSocket upgrade bridge with text/binary echo, subprotocol forwarding and
 * close-code propagation.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  createRawHttpProxy,
  type ProxySession,
} from "../lib/raw_http_proxy.ts";

let upstream: ReturnType<typeof Bun.serve>;
let upstreamPort: number;
let proxy: ReturnType<typeof Bun.serve<ProxySession>>;
let lastUpgradeHeaders: Headers | null = null;
let upstreamClose: { code: number; reason: string } | null = null;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        lastUpgradeHeaders = new Headers(req.headers);
        const protocols = req.headers.get("sec-websocket-protocol");
        const headers = protocols
          ? { "sec-websocket-protocol": protocols.split(",")[0]?.trim() ?? "" }
          : {};
        if (server.upgrade(req, { data: undefined, headers })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      const pathname = new URL(req.url).pathname;
      if (pathname === "/large") {
        return new Response("x".repeat(8_192), {
          headers: { "content-type": "text/plain" },
        });
      }
      if (pathname === "/slow") {
        await Bun.sleep(200);
        return new Response("slow");
      }
      const body = await req.text();
      return Response.json({
        method: req.method,
        url: new URL(req.url).pathname + new URL(req.url).search,
        xTest: req.headers.get("x-test"),
        xHop: req.headers.get("x-hop"),
        body,
      });
    },
    websocket: {
      message(ws, message) {
        ws.send(message);
      },
      close(_ws, code, reason) {
        upstreamClose = { code, reason };
      },
    },
  });

  upstreamPort = upstream.port ?? 0;
  proxy = Bun.serve<ProxySession>({
    port: 0,
    hostname: "127.0.0.1",
    ...createRawHttpProxy({
      hostname: "127.0.0.1",
      port: upstreamPort,
      timeoutMs: 2_000,
      maxRequestBodyBytes: 1_024,
      maxResponseBodyBytes: 4_096,
      maxWebSocketMessageBytes: 1_024,
    }),
  });
});

afterAll(() => {
  proxy.stop(true);
  upstream.stop(true);
});

test("forwards an HTTP request and strips hop-by-hop headers", async () => {
  const response = await fetch(`http://127.0.0.1:${proxy.port}/api/x?y=1`, {
    method: "POST",
    headers: {
      "x-test": "value",
      connection: "x-hop",
      "x-hop": "must-not-arrive",
    },
    body: "hello",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    method: "POST",
    url: "/api/x?y=1",
    xTest: "value",
    xHop: null,
    body: "hello",
  });
});

test("caps a request body over the configured limit", async () => {
  const response = await fetch(`http://127.0.0.1:${proxy.port}/api/x`, {
    method: "POST",
    body: "x".repeat(2_048),
  });

  expect(response.status).toBe(413);
});

test("forwards a WebSocket upgrade and echoes text and binary messages", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`, {
    headers: { "x-test": "ws-value" },
  });
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("client error")), {
      once: true,
    });
  });

  expect(lastUpgradeHeaders?.get("x-test")).toBe("ws-value");

  const text = new Promise<string>((resolve) => {
    socket.addEventListener(
      "message",
      (event) => {
        if (typeof event.data === "string") resolve(event.data);
      },
      { once: true },
    );
  });
  socket.send("hello");
  expect(await text).toBe("hello");

  const binary = new Promise<Uint8Array>((resolve) => {
    socket.addEventListener(
      "message",
      (event) => {
        if (event.data instanceof ArrayBuffer) {
          resolve(new Uint8Array(event.data));
        }
      },
      { once: true },
    );
  });
  socket.send(new Uint8Array([1, 2, 3]));
  expect([...(await binary)]).toEqual([1, 2, 3]);

  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    });
  });
  socket.close(1000, "done");
  expect(await closed).toBe(1000);
  await Bun.sleep(20);
  expect(upstreamClose?.code).toBe(1000);
});

test("forwards the negotiated subprotocol", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`, {
    headers: { "sec-websocket-protocol": "chat" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("client error")),
        { once: true },
      );
    });
    expect(socket.protocol).toBe("chat");
  } finally {
    socket.close();
  }
});

test("caps an upstream response over the configured limit", async () => {
  const response = await fetch(`http://127.0.0.1:${proxy.port}/large`);

  expect(response.status).toBe(502);
});

test("times out a slow upstream", async () => {
  const slowProxy = Bun.serve<ProxySession>({
    port: 0,
    hostname: "127.0.0.1",
    ...createRawHttpProxy({
      hostname: "127.0.0.1",
      port: upstreamPort,
      timeoutMs: 50,
    }),
  });

  try {
    const response = await fetch(`http://127.0.0.1:${slowProxy.port}/slow`);
    expect(response.status).toBe(504);
  } finally {
    slowProxy.stop(true);
  }
});

test("closes a WebSocket message over the configured limit", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`);
  const code = await new Promise<number>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send("x".repeat(2_048));
    });
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    });
    socket.addEventListener("error", () => reject(new Error("client error")), {
      once: true,
    });
  });

  expect(code).toBe(1009);
});
