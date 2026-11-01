import { expect, test } from "bun:test";

import {
  BUN_TERMINAL_SPAWN_PTY_EXAMPLE,
  BUN_TERMINAL_V14_BLOG_URL,
  driveBashScript,
  spawnInPty,
  stripPtyCapture,
} from "./bun_terminal.ts";

test(
  "BUN_TERMINAL_V14_BLOG_URL equals https://bun.sh/blog/bun-v1.4#bun-terminal and spawn example mentions Hello from PTY",
  () => {
    expect(BUN_TERMINAL_V14_BLOG_URL).toBe(
      "https://bun.sh/blog/bun-v1.4#bun-terminal",
    );
    expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE).toContain("Hello from PTY");
  },
);

test(
  "spawnInPty on bun -e console.log(process.stdout.isTTY) exits 0 and prints true",
  async () => {
    const result = await spawnInPty([
      process.execPath,
      "-e",
      "console.log(process.stdout.isTTY)",
    ]);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("true");
  },
);

test(
  "stripPtyCapture removes SGR ANSI escapes and leaves plain hi from red hi",
  () => {
    expect(stripPtyCapture("\x1b[31mhi\x1b[0m")).toBe("hi");
  },
);

test.skipIf(Bun.which("bash") === null)(
  "driveBashScript echo pty-helper then exit runs bash under PTY and captures pty-helper with exit 0",
  async () => {
    const result = await driveBashScript(["echo pty-helper", "exit"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("pty-helper");
  },
);
