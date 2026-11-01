import { describe, expect, test } from "bun:test";

import {
  BUN_TERMINAL_SPAWN_PTY_EXAMPLE,
  BUN_TERMINAL_V14_BLOG_URL,
  spawnInPty,
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
});
