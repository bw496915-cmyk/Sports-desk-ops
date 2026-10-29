import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * WHATWG Fetch & Bun Streaming Request Body Semantics:
 * - ReadableStream body: Sent without Content-Length.
 *   - Under HTTP/1.1: Uses Transfer-Encoding: chunked.
 *   - Under HTTP/2: Uses HTTP/2 DATA frames (no chunked transfer header).
 * - duplex: "half":
 *   - Node.js 18+ requires `duplex: "half"` for ReadableStream bodies and throws otherwise.
 *   - Bun DOES NOT require `duplex: "half"`; it streams natively regardless of whether
 *     duplex is specified. However, `duplex: "half"` is accepted without error for cross-runtime compatibility.
 * - Body single-use: A Request object with a stream or body can only be consumed once.
 *   Attempting to read or fetch an already-disturbed body throws TypeError.
 * - FormData boundary regeneration: Each fetch/Request instance generated from a FormData
 *   instance generates a unique multipart boundary string.
 */

describe("RequestInit ReadableStream body and duplex behavior in Bun", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let receivedChunks: string[] = [];
  let capturedHeaders: Headers | null = null;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        capturedHeaders = req.headers;
        receivedChunks = [];
        if (req.body) {
          const reader = req.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedChunks.push(decoder.decode(value));
          }
        }
        return new Response("ok", { status: 200 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  function createTestStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("frame-01:"));
        controller.enqueue(encoder.encode("frame-02:"));
        controller.enqueue(encoder.encode("frame-03"));
        controller.close();
      },
    });
  }

  test("ReadableStream body WITHOUT duplex: 'half' streams successfully in Bun", async () => {
    capturedHeaders = null;
    const stream = createTestStream();

    const response = await fetch(`${baseUrl}/stream`, {
      method: "POST",
      body: stream,
    });

    expect(response.status).toBe(200);
    expect(receivedChunks.join("")).toBe("frame-01:frame-02:frame-03");
    // Under HTTP/1.1 loopback, verify no Content-Length header was set
    expect(capturedHeaders!.get("content-length")).toBeNull();
  });

  test("ReadableStream body WITH duplex: 'half' is accepted and streams successfully", async () => {
    capturedHeaders = null;
    const stream = createTestStream();

    const response = await fetch(`${baseUrl}/stream`, {
      method: "POST",
      body: stream,
      duplex: "half",
    });

    expect(response.status).toBe(200);
    expect(receivedChunks.join("")).toBe("frame-01:frame-02:frame-03");
  });

  test("Body single-use invariant: consumed Request body cannot be re-read", async () => {
    const stream = createTestStream();
    const req = new Request("http://127.0.0.1/test", {
      method: "POST",
      body: stream,
      duplex: "half",
    });

    // First read consumes the stream
    const firstText = await req.text();
    expect(firstText).toBe("frame-01:frame-02:frame-03");
    expect(req.bodyUsed).toBe(true);

    // Second read must reject or throw because the body is disturbed
    await expect(req.text()).rejects.toThrow();
  });

  test("FormData generates distinct boundary strings across independent Request instances", () => {
    const form = new FormData();
    form.append("key", "value");

    const req1 = new Request("http://127.0.0.1/form", {
      method: "POST",
      body: form,
    });
    const req2 = new Request("http://127.0.0.1/form", {
      method: "POST",
      body: form,
    });

    const ct1 = req1.headers.get("content-type");
    const ct2 = req2.headers.get("content-type");

    expect(ct1).toMatch(/^multipart\/form-data;\s*boundary=/);
    expect(ct2).toMatch(/^multipart\/form-data;\s*boundary=/);
    // Boundaries are randomly generated per request
    expect(ct1).not.toBe(ct2);
  });
});
