import { describe, expect, test } from "bun:test";

import { BUN_TERMINAL_PTY_TEST_NAME } from "./bun_terminal_test_names.ts";

describe("bun_terminal_test_names", () => {
  test("every PTY test title follows layer · surface · action · expects pattern", () => {
    const titles = [
      BUN_TERMINAL_PTY_TEST_NAME.meta.v14BlogUrlAndSpawnSnippetPinned,
      BUN_TERMINAL_PTY_TEST_NAME.meta.v14BlogCapabilitiesShipNote,
      BUN_TERMINAL_PTY_TEST_NAME.meta.v14BlogSpawnExampleRunnable,
      BUN_TERMINAL_PTY_TEST_NAME.util.stripAnsiSgr,
      BUN_TERMINAL_PTY_TEST_NAME.spawn.childReportsIsTty,
      BUN_TERMINAL_PTY_TEST_NAME.spawn.driveBashEchoCapture,
      BUN_TERMINAL_PTY_TEST_NAME.blog.bashLcEcho,
      BUN_TERMINAL_PTY_TEST_NAME.blog.bashTerminalWriteScript,
      BUN_TERMINAL_PTY_TEST_NAME.blog.vimBatchQuit,
      BUN_TERMINAL_PTY_TEST_NAME.blog.vimIsattyStdout,
      BUN_TERMINAL_PTY_TEST_NAME.blog.htopTuiFooterThenKill,
    ];
    for (const title of titles) {
      expect(title).toMatch(/^terminal\.(meta|util|pty) · /);
      expect(title).toContain(" · expects ");
    }
  });

  test("blog program titles are unique and name bash vim htop surfaces", () => {
    const blog = Object.values(BUN_TERMINAL_PTY_TEST_NAME.blog);
    expect(new Set(blog).size).toBe(blog.length);
    expect(blog.some((t) => t.includes("blog.bash"))).toBe(true);
    expect(blog.some((t) => t.includes("blog.vim"))).toBe(true);
    expect(blog.some((t) => t.includes("blog.htop"))).toBe(true);
  });
});
