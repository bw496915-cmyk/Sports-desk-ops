import { describe, expect, test } from "bun:test";

import {
  prefetchDns,
  readDnsCacheStats,
  warmCaptureNetwork,
} from "./preflight.ts";

describe("preflight dns warm", () => {
  test("prefetchDns and warmCaptureNetwork do not throw for fantasy402", () => {
    expect(() => prefetchDns("fantasy402.com", 443)).not.toThrow();
    const warmed = warmCaptureNetwork("https://www.fantasy402.com");
    expect(warmed.host).toBe("www.fantasy402.com");
    expect(warmed.port).toBe(443);
  });

  test("readDnsCacheStats returns object or undefined", () => {
    prefetchDns("example.com", 443);
    const stats = readDnsCacheStats();
    if (stats !== undefined) {
      expect(typeof stats).toBe("object");
    }
  });
});
