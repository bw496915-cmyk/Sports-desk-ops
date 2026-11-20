/**
 * @file tests/routed_endpoints_wire.test.ts
 * @description Wire-level assertions for the routed endpoints. `fetch` hides
 * the status line, header casing and empty 304 bodies; these use a raw TCP
 * client so OPTIONS preflight, custom headers, Range and 304 are asserted on
 * the actual HTTP/1.1 response.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import { startServer } from "../services/sportsdesk_webview_server.ts";
import { rawTcp } from "./support/raw_tcp.ts";

let server: ReturnType<typeof startServer>;
let port: number;

beforeAll(() => {
  server = startServer({ port: 0, hostname: "127.0.0.1" });
  if (server.port === undefined) throw new Error("server did not bind a port");
  port = server.port;
});

afterAll(() => {
  server.stop(true);
});

test("/healthz answers at the wire level", async () => {
  const response = await rawTcp("/healthz", { port, readBody: true });

  expect(response.version).toBe("HTTP/1.1");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")?.[0]).toContain("text/plain");
  expect(new TextDecoder().decode(response.body)).toBe("ok\n");
});

test("/ready carries its custom header", async () => {
  const response = await rawTcp("/ready", { port });

  expect(response.status).toBe(200);
  expect(response.headers.get("x-ready")).toEqual(["1"]);
});

test("OPTIONS preflight is a wire-level 204 with no body", async () => {
  const response = await rawTcp("/health", {
    port,
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1:58514",
      "access-control-request-method": "GET",
    },
  });

  expect(response.status).toBe(204);
  expect(response.body.byteLength).toBe(0);
  expect(response.headers.has("access-control-allow-methods")).toBe(true);
});

test("a Range request is a 206 on the wire", async () => {
  const response = await rawTcp("/live-bets", {
    port,
    headers: { "accept-encoding": "gzip", range: "bytes=0-9" },
  });

  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")?.[0]).toStartWith("bytes 0-9/");
  expect(response.headers.has("content-encoding")).toBe(false);
});

test("a matching ETag returns an empty 304 body", async () => {
  const first = await rawTcp("/status", { port });
  const etag = first.headers.get("etag")?.[0];
  if (etag === undefined) throw new Error("ETag missing");

  const revalidated = await rawTcp("/status", {
    port,
    headers: { "if-none-match": etag },
    readBody: true,
  });

  expect(revalidated.status).toBe(304);
  expect(revalidated.body.byteLength).toBe(0);
});
