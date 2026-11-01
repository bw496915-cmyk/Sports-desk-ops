import { describe, expect, test } from "bun:test";

/**
 * Guards the runtime surface the capture and docs tooling actually calls.
 *
 * A Bun downgrade or a stripped build should fail here rather than halfway through a capture run.
 * Presence only: this never opens a socket or a database.
 */
describe("Bun capabilities used by the ops tooling", () => {
  test("version floor", () => {
    expect(Bun.semver.satisfies(Bun.version, ">=1.4.4-0")).toBe(true);
  });

  test("network primitives exist", () => {
    expect(typeof Bun.fetch).toBe("function");
    expect(typeof Bun.serve).toBe("function");
    expect(typeof Bun.connect).toBe("function");
    expect(typeof Bun.listen).toBe("function");
    expect(typeof Bun.udpSocket).toBe("function");
    expect(typeof Bun.FetchSession).toBe("function");
    expect(typeof WebSocket).toBe("function");
  });

  test("DNS resolution is available for the capture preflight", () => {
    // `Bun.dns.lookup` is the call `capture:preflight` depends on; verify it exists in this build.
    // `resolve` is present at runtime but missing from the 1.4.4 type surface, hence the cast.
    const dns = Bun.dns as unknown as Record<string, unknown>;
    expect(typeof dns["lookup"]).toBe("function");
    expect(typeof dns["resolve"]).toBe("function");
  });

  test("storage and parsing APIs exist", () => {
    expect(typeof Bun.SQL).toBe("function");
    expect(typeof Bun.S3Client).toBe("function");
    expect(typeof Bun.RedisClient).toBe("function");
    expect(typeof Bun.cron).toBe("function");
    expect(typeof Bun.Image).toBe("function");
    expect(typeof Bun.CookieMap).toBe("function");
    expect(typeof Bun.secrets.get).toBe("function");
    expect(typeof Bun.JSONL.parse).toBe("function");
    expect(typeof HTMLRewriter).toBe("function");
  });
});
