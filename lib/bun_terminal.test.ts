import { describe, expect, test } from "bun:test";

import {
  BUN_TERMINAL_SPAWN_PTY_EXAMPLE,
  BUN_TERMINAL_V14_BLOG_URL,
  driveBashScript,
  spawnInPty,
  stripPtyCapture,
} from "./bun_terminal.ts";

describe("bun_terminal", () => {
  test("v1.4 blog URL pinned", () => {
    expect(BUN_TERMINAL_V14_BLOG_URL).toBe(
      "https://bun.sh/blog/bun-v1.4#bun-terminal",
    );
    expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE).toContain("Hello from PTY");
  });

  test("spawnInPty child sees TTY", async () => {
    const result = await spawnInPty([
      process.execPath,
      "-e",
      "console.log(process.stdout.isTTY)",
    ]);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("true");
  });

  test("stripPtyCapture removes ANSI", () => {
    expect(stripPtyCapture("\x1b[31mhi\x1b[0m")).toBe("hi");
  });

  test("driveBashScript writes lines", async () => {
    if (Bun.which("bash") === null) return;
    const result = await driveBashScript(["echo pty-helper", "exit"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("pty-helper");
  });
});
