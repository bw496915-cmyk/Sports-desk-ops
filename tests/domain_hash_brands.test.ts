import { describe, expect, test } from "bun:test";
import {
  isSha256Hex,
  sha256HexFromDigest,
  isoDateTimeUtc,
} from "../domain-branded-types.ts";
import { sha256Bytes } from "../lib/schema_binary.ts";

describe("domain hash brands", () => {
  test("sha256HexFromDigest rejects short hex", () => {
    expect(() => sha256HexFromDigest("abc")).toThrow(/64 hex/);
  });

  test("sha256Bytes returns branded digest", () => {
    const d = sha256Bytes(new TextEncoder().encode("x"));
    expect(isSha256Hex(d)).toBe(true);
    expect(d.length).toBe(64);
  });

  test("isoDateTimeUtc rejects garbage", () => {
    expect(() => isoDateTimeUtc("not-a-date")).toThrow(/IsoTime/);
  });
});
