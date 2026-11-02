import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnInPty } from "../lib/bun_terminal.ts";

describe("Bun PTY terminal automation", () => {
  test("the child sees a real TTY", async () => {
    const result = await spawnInPty([
      process.execPath,
      "-e",
      "console.log(process.stdout.isTTY)",
    ]);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("true");
  });

  test("dx help renders to a PTY", async () => {
    const result = await spawnInPty(["./bin/dx", "help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("./bin/dx gslive");
    expect(result.out).toContain("./bin/dx docs");
    expect(result.out).toContain("./bin/dx stale");
  });

  test("dx shot --help renders without launching a browser", async () => {
    const result = await spawnInPty(["./bin/dx", "shot", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Bun.WebView screenshot tool");
    expect(result.out).toContain("--f402-login");
  });

  test("dx shot --help documents --profile", async () => {
    const result = await spawnInPty(["./bin/dx", "shot", "--help"]);
    expect(result.out).toContain("--profile <dir>");
  });

  test("dx shot --profile refuses a missing directory before launching a browser", async () => {
    const result = await spawnInPty([
      "./bin/dx",
      "shot",
      "--profile",
      join(mkdtempSync(join(tmpdir(), "shot-profile-")), "absent"),
    ]);
    expect(result.code).toBe(2);
    expect(result.out).toContain("is not a directory");
  });

  test("dx shot rejects out-of-range --thumb and --retries before launching a browser", async () => {
    const thumb = await spawnInPty([
      "./bin/dx",
      "shot",
      "https://example.com",
      "--thumb",
      "8",
    ]);
    expect(thumb.code).toBe(2);
    expect(thumb.out).toContain("--thumb must be an integer from 16 to 2048");
    const retries = await spawnInPty([
      "./bin/dx",
      "shot",
      "https://example.com",
      "--retries",
      "9",
    ]);
    expect(retries.code).toBe(2);
    expect(retries.out).toContain("--retries must be an integer from 0 to 5");
  });

  test("dx shot --cookies refuses WebKit before launching a browser", async () => {
    const result = await spawnInPty([
      "./bin/dx",
      "shot",
      "https://example.com",
      "--backend",
      "webkit",
      "--cookies",
    ]);
    expect(result.code).toBe(2);
    expect(result.out).toContain("only --backend chrome has");
  });

  test("dx session defaults to the read-only status report", async () => {
    const result = await spawnInPty([
      "env",
      "-i",
      `PATH=${process.env["PATH"] ?? ""}`,
      `HOME=${process.env["HOME"] ?? ""}`,
      "F402_SESSION_FILE=/nonexistent/f402-session.json",
      "./bin/dx",
      "session",
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("sessionPath");
    expect(result.out).toContain("no cached session");
  });

  test("dx session rejects an unknown subcommand", async () => {
    const result = await spawnInPty(["./bin/dx", "session", "bogus"]);
    expect(result.code).toBe(2);
    expect(result.out).toContain("usage: ./bin/dx session");
  });

  test("dx docs --json parses from PTY output", async () => {
    const result = await spawnInPty(["./bin/dx", "docs", "--json"]);
    expect(result.code).toBe(0);
    const extension = JSON.parse(result.out.trim()) as {
      provider?: string;
      partnerId?: number;
      surfaces?: unknown[];
    };
    expect(extension.provider).toBe("GSLive Manager (Partner 118)");
    expect(extension.partnerId).toBe(118);
    expect(extension.surfaces).toHaveLength(3);
  });
});
