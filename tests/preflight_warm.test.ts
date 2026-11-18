import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  prefetchDns,
  resolveUrlPort,
  warmCaptureNetwork,
} from "../lib/preflight.ts";

describe("capture network warm-up", () => {
  test("warmCaptureNetwork returns the parsed host/port and prefetches", () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    });
    try {
      const port = server.port;
      if (port === undefined) throw new Error("server has no port");
      const warm = warmCaptureNetwork(server.url.href);
      expect(warm).toEqual({ host: "127.0.0.1", port });
      expect(() => prefetchDns("127.0.0.1", port)).not.toThrow();
    } finally {
      server.stop(true);
    }
  });

  test("prefetch ports are validated and URL defaults are scheme-aware", () => {
    expect(() => prefetchDns("127.0.0.1", 0)).toThrow(
      /ERR_DNS_INVALID_PREFETCH_PORT/,
    );
    expect(() => prefetchDns("127.0.0.1", 70_000)).toThrow(
      /ERR_DNS_INVALID_PREFETCH_PORT/,
    );
    expect(() => prefetchDns("127.0.0.1", 443.5)).toThrow(
      /ERR_DNS_INVALID_PREFETCH_PORT/,
    );
    expect(() => prefetchDns("127.0.0.1", Number.NaN)).toThrow(
      /ERR_DNS_INVALID_PREFETCH_PORT/,
    );
    expect(resolveUrlPort(new URL("http://example.test/"))).toBe(80);
    expect(resolveUrlPort(new URL("https://example.test/"))).toBe(443);
    expect(resolveUrlPort(new URL("ws://example.test/"))).toBe(80);
    expect(resolveUrlPort(new URL("wss://example.test/"))).toBe(443);
    expect(() => resolveUrlPort(new URL("ftp://example.test/"))).toThrow(
      /ERR_DNS_INVALID_PREFETCH_PORT/,
    );
  });

  test("capture TLS paths never disable certificate verification", async () => {
    for (const path of [
      "lib/preflight.ts",
      "scripts/capture/session.ts",
      "lib/f402_replay_transport.ts",
      "services/sportsdesk_telegram_bot.ts",
      "scripts/watchdog_endpoint_probe.ts",
      "lib/tls_provenance.ts",
    ]) {
      const text = await Bun.file(join(import.meta.dir, "..", path)).text();
      expect(text, path).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
      expect(text, path).not.toMatch(/rejectUnauthorized:\s*false/);
    }
  });

  test("the endpoint probe pins certificate verification on", async () => {
    for (const path of [
      "scripts/watchdog_endpoint_probe.ts",
      "lib/tls_provenance.ts",
    ]) {
      const text = await Bun.file(join(import.meta.dir, "..", path)).text();
      expect(text, path).toContain("rejectUnauthorized: true");
      expect(text, path).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
      expect(text, path).not.toMatch(/rejectUnauthorized:\s*false/);
      expect(text, path).not.toContain("checkServerIdentity");
    }
  });
});
