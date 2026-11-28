/**
 * @file tests/console_depth.test.ts
 * @description The shared console-depth chain used by the terminal `depth` command,
 * `cli/console_depth.ts`, and the DSH plugin tool.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  renderConsoleDepthReport,
  resolveConsoleDepthChain,
} from "../lib/console_depth.ts";

const ROOT = resolve(import.meta.dir, "..");
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "console-depth-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveConsoleDepthChain", () => {
  test("bunfig wins over the profile env", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "bunfig.toml"), "[console]\ndepth = 5\n");

    const chain = await resolveConsoleDepthChain({
      cwd: dir,
      env: { PTY_CONSOLE_DEPTH: "3" },
    });

    expect(chain.bunfig).toBe(5);
    expect(chain.profileEnv).toEqual({ raw: "3", value: 3 });
    expect(chain.effective).toBe(5);
    expect(chain.winner).toBe("bunfig [console].depth");
  });

  test("falls back to the profile env without bunfig", async () => {
    const dir = scratch();
    const chain = await resolveConsoleDepthChain({
      cwd: dir,
      env: { PTY_CONSOLE_DEPTH: "3" },
    });

    expect(chain.bunfig).toBeNull();
    expect(chain.effective).toBe(3);
    expect(chain.winner).toBe("PTY_CONSOLE_DEPTH");
  });

  test("uses an explicit resolved option when bunfig is absent", async () => {
    const dir = scratch();
    const chain = await resolveConsoleDepthChain({
      cwd: dir,
      env: { PTY_CONSOLE_DEPTH: "" },
      consoleDepth: 7,
    });

    expect(chain.effective).toBe(7);
    expect(chain.winner).toBe("resolved option");
  });

  test("marks invalid profile text instead of using it", async () => {
    const dir = scratch();
    const chain = await resolveConsoleDepthChain({
      cwd: dir,
      env: { PTY_CONSOLE_DEPTH: "6.9" },
    });

    expect(chain.profileEnv).toEqual({ raw: "6.9", value: null });
    expect(chain.effective).toBe(2);
    expect(chain.winner).toBe("Bun default");
    expect(renderConsoleDepthReport(chain)).toContain('invalid ("6.9")');
  });
});

test("cli --json emits the chain for the caller cwd", () => {
  const dir = scratch();
  writeFileSync(join(dir, "bunfig.toml"), "[console]\ndepth = 6\n");

  const result = Bun.spawnSync(
    [process.execPath, join(ROOT, "cli/console_depth.ts"), "--json"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );

  expect(result.exitCode).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout.toString());
  expect(parsed).toMatchObject({
    bunfig: 6,
    effective: 6,
    winner: "bunfig [console].depth",
  });
});
