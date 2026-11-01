import { expect, test } from "bun:test";

import {
  BUN_TERMINAL_SPAWN_PTY_EXAMPLE,
  BUN_TERMINAL_V14_BLOG_URL,
  driveBashScript,
  spawnInPty,
  stripPtyCapture,
} from "./bun_terminal.ts";
import { BUN_TERMINAL_PTY_TEST_NAME } from "./bun_terminal_test_names.ts";

test(BUN_TERMINAL_PTY_TEST_NAME.meta.v14BlogUrlAndSpawnSnippetPinned, () => {
  expect(BUN_TERMINAL_V14_BLOG_URL).toBe(
    "https://bun.sh/blog/bun-v1.4#bun-terminal",
  );
  expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE).toContain("Hello from PTY");
});

test(BUN_TERMINAL_PTY_TEST_NAME.spawn.childReportsIsTty, async () => {
  const result = await spawnInPty([
    process.execPath,
    "-e",
    "console.log(process.stdout.isTTY)",
  ]);
  expect(result.code).toBe(0);
  expect(result.out.trim()).toBe("true");
});

test(BUN_TERMINAL_PTY_TEST_NAME.util.stripAnsiSgr, () => {
  expect(stripPtyCapture("\x1b[31mhi\x1b[0m")).toBe("hi");
});

test.skipIf(Bun.which("bash") === null)(
  BUN_TERMINAL_PTY_TEST_NAME.spawn.driveBashEchoCapture,
  async () => {
    const result = await driveBashScript(["echo pty-helper", "exit"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("pty-helper");
  },
);
