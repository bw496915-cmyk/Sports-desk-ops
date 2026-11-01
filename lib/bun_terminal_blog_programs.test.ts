import { describe, expect, test } from "bun:test";

import {
  driveBashScript,
  spawnInPty,
  spawnInPtyUntil,
} from "./bun_terminal.ts";

const bashPath = Bun.which("bash");
const vimPath = Bun.which("vim");
const htopPath = Bun.which("htop");

describe("Bun.Terminal blog programs (bash, vim, htop)", () => {
  test.skipIf(bashPath === null)("bash: login command under PTY", async () => {
    const result = await spawnInPty([bashPath!, "-lc", "echo Hello from bash PTY"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Hello from bash PTY");
  });

  test.skipIf(bashPath === null)(
    "bash: terminal.write drives interactive shell",
    async () => {
      const result = await driveBashScript([
        "echo scripted-input",
        "exit",
      ]);
      expect(result.code).toBe(0);
      expect(result.out).toContain("scripted-input");
    },
  );

  test.skipIf(vimPath === null)("vim: batch quit under PTY", async () => {
    const result = await spawnInPty([
      vimPath!,
      "-N",
      "-u",
      "NONE",
      "-n",
      "-c",
      "qa!",
    ]);
    expect(result.code).toBe(0);
  });

  test.skipIf(vimPath === null)("vim: sees TTY inside session", async () => {
    const result = await spawnInPty([
      vimPath!,
      "-N",
      "-u",
      "NONE",
      "-n",
      "-c",
      "echo isatty(1)",
      "-c",
      "qa!",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/1|true/i);
  });

  test.skipIf(htopPath === null)("htop: TUI paints under PTY", async () => {
    const htopUi = /F10Quit|F1Help|htoprc/i;
    const result = await spawnInPtyUntil([htopPath!], {
      cols: 120,
      rows: 40,
      untilOutput: htopUi,
      maxMs: 3000,
    });
    expect(result.rawBytes).toBeGreaterThan(100);
    expect(result.out).toMatch(htopUi);
    expect(result.killed).toBe(true);
  });
});
