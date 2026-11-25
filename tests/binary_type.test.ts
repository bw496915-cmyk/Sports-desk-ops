/**
 * @file tests/binary_type.test.ts
 * @description Unit and integration tests for `src/lib/binary_type.ts` and `packages/api/src/ws.ts` `binaryType` handling.
 */

import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

import { createDashboardWebSocketHandler } from "../packages/api/src/ws.ts";
import {
  type BlobStore,
  createBlobLiveBetsServer,
} from "../services/blob_and_live_bets_server.ts";
import {
  assertBinaryTypeMatch,
  CLIENT_WS_BINARY_TYPES,
  classifyBinaryPayload,
  createSocketBinaryHandler,
  decodeBinaryFrameText,
  decodeWsEventText,
  isClientWsBinaryType,
  isJscSerializeBinaryType,
  isServerWsBinaryType,
  isSocketBinaryType,
  JSC_SERIALIZE_BINARY_TYPES,
  SERVER_WS_BINARY_TYPES,
  SOCKET_BINARY_TYPES,
  toArrayBufferExact,
  toBufferView,
  toDataView,
  toUint8ArrayView,
} from "../src/lib/binary_type.ts";

describe("Bun BinaryType guards and payload helpers", () => {
  test("distinguishes socket, server WS, and client WS binaryType unions", () => {
    expect([...SOCKET_BINARY_TYPES]).toEqual([
      "arraybuffer",
      "buffer",
      "uint8array",
    ]);
    expect([...SERVER_WS_BINARY_TYPES]).toEqual([
      "nodebuffer",
      "arraybuffer",
      "uint8array",
      "blob",
    ]);
    expect([...CLIENT_WS_BINARY_TYPES]).toEqual([
      "arraybuffer",
      "blob",
      "nodebuffer",
    ]);

    expect(isSocketBinaryType("buffer")).toBe(true);
    expect(isSocketBinaryType("nodebuffer")).toBe(false);
    expect(isSocketBinaryType("blob")).toBe(false);

    expect(isServerWsBinaryType("nodebuffer")).toBe(true);
    expect(isServerWsBinaryType("uint8array")).toBe(true);
    expect(isServerWsBinaryType("buffer")).toBe(false);

    expect(isClientWsBinaryType("arraybuffer")).toBe(true);
    expect(isClientWsBinaryType("uint8array")).toBe(false);
    expect(isClientWsBinaryType("buffer")).toBe(false);

    expect([...JSC_SERIALIZE_BINARY_TYPES]).toEqual([
      "arraybuffer",
      "nodebuffer",
    ]);
    expect(isJscSerializeBinaryType("arraybuffer")).toBe(true);
    expect(isJscSerializeBinaryType("nodebuffer")).toBe(true);
    expect(isJscSerializeBinaryType("buffer")).toBe(false);
  });

  test("classifyBinaryPayload separates Buffer from bare Uint8Array", () => {
    const buf = Buffer.from([1, 2, 3]);
    const u8 = new Uint8Array([1, 2, 3]);
    const ab = u8.buffer.slice(0);
    const blob = new Blob(["hi"]);

    expect(classifyBinaryPayload(buf)).toMatchObject({
      kind: "buffer",
      isBuffer: true,
      isUint8Array: true,
      byteLength: 3,
    });
    expect(classifyBinaryPayload(u8)).toMatchObject({
      kind: "uint8array",
      isBuffer: false,
      isUint8Array: true,
      byteLength: 3,
    });
    expect(classifyBinaryPayload(ab)).toMatchObject({
      kind: "arraybuffer",
      isArrayBuffer: true,
      isUint8Array: false,
      byteLength: 3,
    });
    expect(classifyBinaryPayload(blob)).toMatchObject({
      kind: "blob",
      isBlob: true,
      byteLength: 2,
    });
    expect(classifyBinaryPayload("ok")).toMatchObject({
      kind: "string",
      byteLength: 2,
    });
    expect(classifyBinaryPayload(42)).toMatchObject({
      kind: "unknown",
      byteLength: null,
    });
  });

  test("toUint8ArrayView creates a zero-copy bare Uint8Array over sliced views and ArrayBuffers", () => {
    const backing = new Uint8Array([10, 20, 30, 40, 50]);
    const slicedBuf = Buffer.from(backing.buffer, 1, 3);
    const viewFromBuf = toUint8ArrayView(slicedBuf);

    expect(viewFromBuf).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(viewFromBuf)).toBe(false);
    expect(viewFromBuf.buffer).toBe(backing.buffer);
    expect(Array.from(viewFromBuf)).toEqual([20, 30, 40]);

    const viewFromAb = toUint8ArrayView(backing.buffer);
    expect(viewFromAb.buffer).toBe(backing.buffer);
    expect(Array.from(viewFromAb)).toEqual([10, 20, 30, 40, 50]);
  });

  test("decodeBinaryFrameText and decodeWsEventText decode string, binary, and Blob frames", async () => {
    const json = '{"kind":"f402-bet-ticker","newTickets":2}';
    const bytes = new TextEncoder().encode(json);

    expect(decodeBinaryFrameText(json)).toBe(json);
    expect(decodeBinaryFrameText(bytes)).toBe(json);
    expect(decodeBinaryFrameText(bytes.buffer)).toBe(json);
    expect(decodeBinaryFrameText(Buffer.from(bytes))).toBe(json);

    expect(await decodeWsEventText(json)).toBe(json);
    expect(await decodeWsEventText(bytes.buffer)).toBe(json);
    expect(await decodeWsEventText(new Blob([json]))).toBe(json);
    expect(await decodeWsEventText(null)).toBeNull();
  });

  test("createSocketBinaryHandler preserves exact binaryType property", () => {
    const handler = createSocketBinaryHandler("uint8array", {
      data(_socket, data) {
        const bytes: Uint8Array = data;
        expect(bytes.byteLength).toBeGreaterThanOrEqual(0);
      },
    });
    expect(handler.binaryType).toBe("uint8array");
  });

  test("toDataView, toBufferView, and toArrayBufferExact handle slices and SharedArrayBuffer safely", () => {
    const backing = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0xff]);
    const slice = Buffer.from(backing.buffer, 1, 4);

    const dv = toDataView(slice);
    expect(dv.byteLength).toBe(4);
    expect(dv.getUint32(0, false)).toBe(0x01020304);
    expect(dv.getUint32(0, true)).toBe(0x04030201);

    const bufView = toBufferView(slice);
    expect(Buffer.isBuffer(bufView)).toBe(true);
    expect(bufView.buffer).toBe(backing.buffer);
    expect(Array.from(bufView)).toEqual([1, 2, 3, 4]);

    // Full-span plain ArrayBuffer view stays zero-copy; subrange copies only the slice.
    expect(toArrayBufferExact(backing)).toBe(backing.buffer);
    const exactSlice = toArrayBufferExact(slice);
    expect(exactSlice).not.toBe(backing.buffer);
    expect(Array.from(new Uint8Array(exactSlice))).toEqual([1, 2, 3, 4]);

    // SharedArrayBuffer view always produces a detached plain ArrayBuffer copy.
    const sab = new SharedArrayBuffer(4);
    new Uint8Array(sab).set([7, 8, 9, 10]);
    const fromSab = toArrayBufferExact(new Uint8Array(sab));
    expect(fromSab).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(fromSab))).toEqual([7, 8, 9, 10]);
  });

  test("assertBinaryTypeMatch narrows valid payloads and fails closed on mismatches", () => {
    const u8 = new Uint8Array([9, 8]);
    const buf = Buffer.from([9, 8]);
    expect(assertBinaryTypeMatch("uint8array", u8)).toBe(u8);
    expect(assertBinaryTypeMatch("buffer", buf)).toBe(buf);
    expect(() => assertBinaryTypeMatch("uint8array", buf)).toThrow(
      /ERR_BINARY_TYPE_MISMATCH: expected uint8array, received buffer/,
    );
  });
});

describe("createBlobLiveBetsServer binary WS control frame integration", () => {
  test("decodes binary-encoded PING frames under ws.binaryType=uint8array", async () => {
    const emptyStore: BlobStore = {
      async put() {
        return { bytesWritten: 0 };
      },
      presignGet: () => "https://example.invalid/blob",
      async exists() {
        return false;
      },
      async stat() {
        return { size: 0, contentType: "application/octet-stream" };
      },
      async getResponse() {
        return new Response(null, { status: 404 });
      },
      async delete() {},
    };

    const gateway = createBlobLiveBetsServer({
      blobs: emptyStore,
      apiToken: "test-token",
      ticketSecret: "test-secret",
      port: 0,
      hostname: "127.0.0.1",
    });

    try {
      const ticketRes = await fetch(
        `http://127.0.0.1:${gateway.server.port}/api/v1/ws-tickets`,
        {
          method: "POST",
          headers: { authorization: "Bearer test-token" },
        },
      );
      const { ticket } = (await ticketRes.json()) as { ticket: string };
      const ws = new WebSocket(
        `ws://127.0.0.1:${gateway.server.port}/ws/live-bets`,
        ["live-bets.v1", `ticket.${ticket}`],
      );
      ws.binaryType = "arraybuffer";

      try {
        const reply = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("live-bets binary PING timeout")),
            3_000,
          );
          ws.addEventListener("open", () => {
            ws.send(new TextEncoder().encode(JSON.stringify({ type: "PING" })));
          });
          ws.addEventListener("message", (event) => {
            clearTimeout(timer);
            void decodeWsEventText(event.data).then((t) => resolve(t ?? ""));
          });
          ws.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("live-bets ws error"));
          });
        });
        const parsed = JSON.parse(reply) as { type?: string; ts?: number };
        expect(parsed.type).toBe("PONG");
        expect(typeof parsed.ts).toBe("number");
      } finally {
        ws.close();
      }
    } finally {
      gateway.close(true);
    }
  });
});

describe("createDashboardWebSocketHandler binaryType integration", () => {
  test("sets ws.binaryType to uint8array by default and decodes binary JSON control frames", async () => {
    const clients = new Set<ServerWebSocket<undefined>>();
    const { websocket } = createDashboardWebSocketHandler(clients);
    let observedBinaryType: string | undefined;

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) =>
        srv.upgrade(req) ? undefined : new Response("no", { status: 426 }),
      websocket: {
        ...websocket,
        open(ws) {
          websocket.open(ws);
          observedBinaryType = ws.binaryType;
        },
      },
    });

    const client = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    client.binaryType = "arraybuffer";
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("dashboard ws binary frame timeout")),
          3_000,
        );
        client.addEventListener("open", () => {
          client.send(
            new TextEncoder().encode(
              JSON.stringify({ type: "query-subscriptions" }),
            ),
          );
        });
        client.addEventListener("message", (event) => {
          clearTimeout(timer);
          void decodeWsEventText(event.data).then((text) =>
            resolve(text ?? ""),
          );
        });
        client.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("dashboard ws client error"));
        });
      });

      expect(observedBinaryType).toBe("uint8array");
      const parsed = JSON.parse(reply) as {
        type?: string;
        activeTopics?: string[];
      };
      expect(parsed.type).toBe("subscriptions");
      expect(parsed.activeTopics).toContain("dashboard");
    } finally {
      client.close();
      server.stop(true);
    }
  });
});
