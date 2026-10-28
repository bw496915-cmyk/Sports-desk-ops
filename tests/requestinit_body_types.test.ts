import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * WHATWG Fetch § "extract a body":
 * https://fetch.spec.whatwg.org/#concept-bodyinit-extract
 *
 * Steps for extracting a body from object with keepalive:
 * 1. If object is a BufferSource (ArrayBuffer or ArrayBufferView):
 *    - action: copy object's bytes.
 *    - source: byte sequence.
 *    - type: null. (CRITICAL: type is NULL, NO default Content-Type is set!)
 *    There is NO default "application/octet-stream" in WHATWG Fetch.
 *    If an application does not provide a Content-Type header explicitly,
 *    no Content-Type header is transmitted over the wire.
 * 2. If object is a Blob:
 *    - type: if object's type is non-empty, type is object's type; otherwise null.
 * 3. If object is a USVString:
 *    - type: "text/plain;charset=UTF-8".
 * 4. If object is a FormData:
 *    - type: "multipart/form-data; boundary=...".
 * 5. If object is a URLSearchParams:
 *    - type: "application/x-www-form-urlencoded;charset=UTF-8".
 * 6. If object is a ReadableStream:
 *    - type: null.
 */

describe("RequestInit body types and emitted Content-Type headers", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let lastCapturedHeaders: Headers | null = null;
  let lastCapturedBodyBytes: Uint8Array | null = null;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        lastCapturedHeaders = req.headers;
        lastCapturedBodyBytes = new Uint8Array(await req.arrayBuffer());
        return new Response("ok", { status: 200 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("1. string body emits text/plain;charset=utf-8", async () => {
    lastCapturedHeaders = null;
    await fetch(`${baseUrl}/test`, {
      method: "POST",
      body: "plain string payload",
    });
    expect(lastCapturedHeaders).not.toBeNull();
    const ct = lastCapturedHeaders!.get("content-type");
    expect(ct).toMatch(/^text\/plain;\s*charset=utf-8/i);
  });

  test("2. URLSearchParams body emits application/x-www-form-urlencoded;charset=utf-8", async () => {
    lastCapturedHeaders = null;
    const params = new URLSearchParams({ key: "val", action: "test" });
    await fetch(`${baseUrl}/test`, {
      method: "POST",
      body: params,
    });
    expect(lastCapturedHeaders).not.toBeNull();
    const ct = lastCapturedHeaders!.get("content-type");
    expect(ct).toMatch(/^application\/x-www-form-urlencoded;\s*charset=utf-8/i);
  });

  test("3. FormData body emits multipart/form-data with boundary", async () => {
    lastCapturedHeaders = null;
    const form = new FormData();
    form.append("user", "test");
    form.append("file", new Blob(["file-content"], { type: "text/plain" }), "test.txt");
    await fetch(`${baseUrl}/test`, {
      method: "POST",
      body: form,
    });
    expect(lastCapturedHeaders).not.toBeNull();
    const ct = lastCapturedHeaders!.get("content-type");
    expect(ct).toMatch(/^multipart\/form-data;\s*boundary=/i);
  });

  test("4. Blob body with explicit type inherits blob.type", async () => {
    lastCapturedHeaders = null;
    const blob = new Blob([JSON.stringify({ a: 1 })], { type: "application/json" });
    await fetch(`${baseUrl}/test`, {
      method: "POST",
      body: blob,
    });
    expect(lastCapturedHeaders).not.toBeNull();
    expect(lastCapturedHeaders!.get("content-type")).toBe("application/json");
  });

  test("5. Blob body with empty type emits NO Content-Type header", async () => {
    lastCapturedHeaders = null;
    const blob = new Blob(["raw text"], { type: "" });
    await fetch(`${baseUrl}/test`, {
      method: "POST",
      body: blob,
    });
    expect(lastCapturedHeaders).not.toBeNull();
    expect(lastCapturedHeaders!.get("content-type")).toBeNull();
  });

  test("6. ArrayBuffer body emits NO Content-Type header (not application/octet-stream)", async () => {
    lastCapturedHeaders = null;
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    await fetch(`${baseUrl}/test`, {
      method: "POST",
      body: buffer,
    });
    expect(lastCapturedHeaders).not.toBeNull();
    // In WHATWG fetch § extract a body: type = null for BufferSource. No Content-Type is set!
    expect(lastCapturedHeaders!.get("content-type")).toBeNull();
  });

  test("7. Uint8Array (BufferSource) emits NO Content-Type header (not application/octet-stream)", async () => {
    lastCapturedHeaders = null;
    const uint8 = new Uint8Array([10, 20, 30, 40]);
    await fetch(`${baseUrl}/test`, {
      method: "POST",
      body: uint8,
    });
    expect(lastCapturedHeaders).not.toBeNull();
    // Demonstrates that BufferSource has NO default Content-Type
    expect(lastCapturedHeaders!.get("content-type")).toBeNull();
  });

  test("8. Uint8Array with explicit Content-Type header transmits specified type", async () => {
    lastCapturedHeaders = null;
    const uint8 = new Uint8Array([10, 20, 30, 40]);
    await fetch(`${baseUrl}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: uint8,
    });
    expect(lastCapturedHeaders).not.toBeNull();
    expect(lastCapturedHeaders!.get("content-type")).toBe("application/octet-stream");
  });

  test("9. ReadableStream body emits NO Content-Type header", async () => {
    lastCapturedHeaders = null;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stream-chunk"));
        controller.close();
      },
    });
    await fetch(`${baseUrl}/test`, {
      method: "POST",
      body: stream,
    });
    expect(lastCapturedHeaders).not.toBeNull();
    expect(lastCapturedHeaders!.get("content-type")).toBeNull();
  });
});
