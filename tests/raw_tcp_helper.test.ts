/**
 * @file tests/raw_tcp_helper.test.ts
 * @description The raw wire helper must not let a test smuggle a second
 * request through a header value, and must respect caller framing headers.
 */

import { expect, test } from "bun:test";

import { buildRequestPayload } from "./support/raw_tcp.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function build(
  headers: Readonly<Record<string, string>> = {},
  bodyBytes: Uint8Array | null = null,
): string {
  return decoder.decode(
    buildRequestPayload("/x", "POST", "127.0.0.1", 4020, headers, bodyBytes),
  );
}

test("rejects CR/LF in method, target, header name and value", () => {
  const rejects = [
    () => buildRequestPayload("/x", "GET\r\nX", "h", 80, {}, null),
    () => buildRequestPayload("/x\r\nX: 1", "GET", "h", 80, {}, null),
    () => buildRequestPayload("/x", "GET", "h", 80, { "X\rY": "v" }, null),
    () => buildRequestPayload("/x", "GET", "h", 80, { X: "v\r\nY: 1" }, null),
  ];
  for (const reject of rejects) {
    expect(reject).toThrow(/ERR_RAW_TCP_INVALID_HEADER/);
  }
});

test("adds Host and Connection defaults", () => {
  const text = build();

  expect(text.startsWith("POST /x HTTP/1.1\r\n")).toBe(true);
  expect(text).toContain("\r\nHost: 127.0.0.1:4020\r\n");
  expect(text).toContain("\r\nConnection: close\r\n");
});

test("omits the port for Host on port 80", () => {
  const text = decoder.decode(
    buildRequestPayload("/x", "GET", "example.test", 80, {}, null),
  );

  expect(text).toContain("\r\nHost: example.test\r\n");
});

test("a caller Host or Connection header wins over the default", () => {
  const text = build({ Host: "override.test", Connection: "keep-alive" });
  const lines = text.split("\r\n");

  expect(lines).toContain("Host: override.test");
  expect(lines).not.toContain("Host: 127.0.0.1:4020");
  expect(lines).toContain("Connection: keep-alive");
  expect(lines).not.toContain("Connection: close");
});

test("adds Content-Length for a body unless the caller framed it", () => {
  const body = encoder.encode("hello");
  const framing = (text: string): string[] =>
    text.split("\r\n").filter((line) => /^content-length:/i.test(line));

  expect(framing(build({}, body))).toEqual(["Content-Length: 5"]);
  expect(framing(build({ "content-length": "5" }, body))).toEqual([
    "content-length: 5",
  ]);
  expect(framing(build({ "transfer-encoding": "chunked" }, body))).toEqual([]);
});

test("an empty body is not framed with Content-Length", () => {
  const framing = build({}, new Uint8Array(0))
    .split("\r\n")
    .filter((line) => /^content-length:/i.test(line));
  expect(framing).toEqual([]);
});

test("rejects a non-token method and a bad request target", () => {
  expect(() => buildRequestPayload("/x", "GE T", "h", 80, {}, null)).toThrow(
    /ERR_RAW_TCP_INVALID_METHOD/,
  );
  expect(() => buildRequestPayload("/x", "", "h", 80, {}, null)).toThrow(
    /ERR_RAW_TCP_INVALID_METHOD/,
  );
  expect(() => buildRequestPayload("/x y", "GET", "h", 80, {}, null)).toThrow(
    /ERR_RAW_TCP_INVALID_TARGET/,
  );
  expect(() => buildRequestPayload("", "GET", "h", 80, {}, null)).toThrow(
    /ERR_RAW_TCP_INVALID_TARGET/,
  );
});

test("rejects invalid header names and control characters in values", () => {
  expect(() => build({ "X Y": "v" })).toThrow(/ERR_RAW_TCP_INVALID_HEADER/);
  expect(() => build({ X: "v\x01" })).toThrow(/ERR_RAW_TCP_INVALID_HEADER/);
  expect(() => build({ "": "v" })).toThrow(/ERR_RAW_TCP_INVALID_HEADER/);
});

test("deduplicates headers case-insensitively, keeping the first", () => {
  const lines = build({ "X-A": "1", "x-a": "2" }).split("\r\n");
  const values = lines.filter((line) => /^x-a:/i.test(line));

  expect(values).toEqual(["X-A: 1"]);
});

test("validates the port and brackets an IPv6 Host", () => {
  expect(() => buildRequestPayload("/x", "GET", "h", 0, {}, null)).toThrow(
    /ERR_RAW_TCP_INVALID_PORT/,
  );
  expect(() => buildRequestPayload("/x", "GET", "h", 70000, {}, null)).toThrow(
    /ERR_RAW_TCP_INVALID_PORT/,
  );

  const ipv6 = decoder.decode(
    buildRequestPayload("/x", "GET", "::1", 4020, {}, null),
  );
  expect(ipv6).toContain("\r\nHost: [::1]:4020\r\n");

  const ipv6Default = decoder.decode(
    buildRequestPayload("/x", "GET", "::1", 80, {}, null),
  );
  expect(ipv6Default).toContain("\r\nHost: [::1]\r\n");
});

test("rejects an empty or control-character hostname", () => {
  expect(() => buildRequestPayload("/x", "GET", "  ", 4020, {}, null)).toThrow(
    /ERR_RAW_TCP_INVALID_HEADER/,
  );
  expect(() =>
    buildRequestPayload("/x", "GET", "bad host", 4020, {}, null),
  ).toThrow(/ERR_RAW_TCP_INVALID_HEADER/);
});
