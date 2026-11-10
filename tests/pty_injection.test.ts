/**
 * @file tests/pty_injection.test.ts
 * @description PTY command execution and shell injection regression suite.
 * Proves that TerminalSession and executeTerminalQuery use direct array-form
 * execve without intermediate shell invocation (sh -c / bash -c), making
 * shell metacharacter injections (; | && ` $() < >) completely inert.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";
import { TerminalSession } from "../lib/bun_terminal.ts";

const PROBE_FILE = `/tmp/pty_injection_exploit_probe_${process.pid}_${Math.random().toString(36).slice(2)}.txt`;

const cleanProbe = () => {
  try {
    unlinkSync(PROBE_FILE);
  } catch {
    // ignore
  }
};

describe("PTY Shell Injection Defense (lib/terminal_emulator.ts & lib/bun_terminal.ts)", () => {
  afterEach(cleanProbe);

  it("treats semicolons as literal arguments, preventing chained command injection", async () => {
    cleanProbe();

    // If passed to a shell (sh -c), touch would create PROBE_FILE
    const result = await executeTerminalQuery(`echo test; touch ${PROBE_FILE}`);

    // Verify file was never created
    const probeFile = Bun.file(PROBE_FILE);
    expect(await probeFile.exists()).toBe(false);

    // Verify stdout printed literal semicolon as argv argument
    expect(result.stdout).toContain("test;");
  });

  it("prevents pipe hijacking in customer query inputs", async () => {
    cleanProbe();

    const result = await executeTerminalQuery(
      `profile GP301 | touch ${PROBE_FILE}`,
    );

    const probeFile = Bun.file(PROBE_FILE);
    expect(await probeFile.exists()).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("prevents backtick command substitution from executing subcommands", async () => {
    cleanProbe();

    const result = await executeTerminalQuery(`echo \`touch ${PROBE_FILE}\``);

    const probeFile = Bun.file(PROBE_FILE);
    expect(await probeFile.exists()).toBe(false);
    expect(result.stdout).toContain("`touch");
  });

  it("prevents $(...) command substitution", async () => {
    cleanProbe();

    const result = await executeTerminalQuery(`echo $(touch ${PROBE_FILE})`);

    const probeFile = Bun.file(PROBE_FILE);
    expect(await probeFile.exists()).toBe(false);
    expect(result.stdout).toContain("$(touch");
  });

  it("TerminalSession.start uses direct array-form execve without shell wrapper", async () => {
    cleanProbe();

    await using session = await TerminalSession.start([
      "echo",
      `safe; touch ${PROBE_FILE}`,
    ]);

    await session.wait();

    const probeFile = Bun.file(PROBE_FILE);
    expect(await probeFile.exists()).toBe(false);
    expect(session.raw).toContain("safe;");
  });
});
