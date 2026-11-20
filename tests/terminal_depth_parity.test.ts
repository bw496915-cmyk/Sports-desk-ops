/**
 * @file tests/terminal_depth_parity.test.ts
 * @description The terminal registry (`NamedColorTokenStore` -> formatProfileDotEnv)
 * and the theme/token registry (`AutomatedDualTokenStore` -> emitArtifacts) both emit
 * the console depth. This pins their parity for the same profile so the two emitters
 * cannot drift apart silently.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatProfileDotEnv,
  NamedColorTokenStore,
} from "../lib/bun_profiled_terminal.ts";
import { AutomatedDualTokenStore } from "../lib/token_automation.ts";

function lineWith(text: string, prefix: string): string | undefined {
  return text.split("\n").find((line) => line.startsWith(prefix));
}

test("both registry emitters agree on PTY_CONSOLE_DEPTH and BUN_OPTIONS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terminal-depth-parity-"));
  try {
    const terminalStore = new NamedColorTokenStore(":memory:");
    terminalStore.setProfile(
      "parity",
      { accent: "red", error: "red", warn: "gold" },
      6,
    );
    const terminalEnv = formatProfileDotEnv(terminalStore, "parity");
    terminalStore.close();

    const tokenStore = new AutomatedDualTokenStore(join(dir, "tokens.sqlite"));
    tokenStore.upsertProfile(
      "parity",
      { accent: "red", error: "red", warn: "gold" },
      { consoleDepth: 6 },
    );
    const { envFile } = await tokenStore.emitArtifacts(
      "parity",
      join(dir, "out"),
      { isTTY: true },
    );
    tokenStore.close();
    const codegenEnv = await Bun.file(envFile).text();

    expect(lineWith(terminalEnv, "PTY_CONSOLE_DEPTH=")).toBe(
      lineWith(codegenEnv, "PTY_CONSOLE_DEPTH="),
    );
    expect(lineWith(terminalEnv, "BUN_OPTIONS=")).toBe(
      lineWith(codegenEnv, "BUN_OPTIONS="),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
