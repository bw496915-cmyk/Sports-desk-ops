import { expect, test } from "bun:test";

import {
  driveBashScript,
  spawnInPty,
  spawnInPtyUntil,
} from "./bun_terminal.ts";

const bashPath = Bun.which("bash");
const vimPath = Bun.which("vim");
const htopPath = Bun.which("htop");

test.skipIf(bashPath === null)(
  "Bun.Terminal PTY runs bash -lc echo and returns exit 0 with Hello from bash PTY on stdout",
  async () => {
    const result = await spawnInPty([
      bashPath!,
      "-lc",
      "echo Hello from bash PTY",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Hello from bash PTY");
  },
);

test.skipIf(bashPath === null)(
  "Bun.Terminal PTY driveBashScript terminal.write sends echo scripted-input and exit then bash exits 0 with that line captured",
  async () => {
    const result = await driveBashScript(["echo scripted-input", "exit"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("scripted-input");
  },
);

test.skipIf(vimPath === null)(
  "Bun.Terminal PTY runs vim -N -u NONE -n -c qa! batch quit and returns exit 0",
  async () => {
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
  },
);

test.skipIf(vimPath === null)(
  "Bun.Terminal PTY runs vim -c echo isatty(1) and PTY capture shows stdout is a TTY before qa!",
  async () => {
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
  },
);

test.skipIf(htopPath === null)(
  "Bun.Terminal PTY runs htop until F1Help or F10Quit paints then SIGTERM leaves more than 100 raw bytes and killed true",
  async () => {
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
  },
);
