import { describe, expect, test } from "bun:test";
import { summarizeBody } from "../lib/http_body.ts";

describe("response body summary", () => {
  test("counts bytes, not characters", async () => {
    // "é" is two bytes; text.length would report 1.
    const response = new Response("é");
    const summary = await summarizeBody(response);
    expect(summary.bytes).toBe(2);
    expect(summary.preview).toBe("é");
    expect(summary.truncated).toBe(false);
  });

  test("truncates the preview without changing the byte count", async () => {
    const text = "a".repeat(100) + "—" + "b".repeat(100);
    const response = new Response(text);
    const summary = await summarizeBody(response, 50);
    expect(summary.bytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(summary.preview).toHaveLength(50);
    expect(summary.preview).toBe("a".repeat(50));
    expect(summary.truncated).toBe(true);
  });

  test("an empty body is zero bytes with an empty preview", async () => {
    const summary = await summarizeBody(new Response(""));
    expect(summary).toEqual({ bytes: 0, preview: "", truncated: false });
  });

  test("a preview larger than the body is not truncated", async () => {
    const summary = await summarizeBody(new Response("{}"), 100);
    expect(summary).toEqual({ bytes: 2, preview: "{}", truncated: false });
  });

  test("a cut mid-character yields a replacement char, not an exception", async () => {
    const summary = await summarizeBody(new Response("é"), 1);
    expect(summary.bytes).toBe(2);
    expect(summary.truncated).toBe(true);
    expect(summary.preview).toBe("\uFFFD");
  });
});
