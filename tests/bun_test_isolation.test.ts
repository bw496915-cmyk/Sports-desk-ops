/**
 * @file tests/bun_test_isolation.test.ts
 * @description Contract test for `bun test --isolate` per-file isolation.
 *
 * Bun 1.4.1 stopped leaking `process.env.TZ` and a live `monitorEventLoopDelay()`
 * between test files. The repo runs `bun test --parallel`, which implies
 * `--isolate`, so this pins the guarantee on the 1.4.5 runtime pin.
 */

// @bun-behavior: bun-test-isolate

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILE_A = `
import { test, expect } from "bun:test";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
test("01 mutates TZ and leaves a monitor enabled", () => {
  process.env.TZ = "Pacific/Kiritimati";
  monitorEventLoopDelay({ resolution: 10 });
  writeFileSync("a-ran", "1");
  expect(process.env.TZ).toBe("Pacific/Kiritimati");
});
`;

const FILE_B = `
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
test("02 sees a clean environment", () => {
  expect(existsSync("a-ran")).toBe(true);
  expect(process.env.TZ).toBeUndefined();
});
`;

describe("bun test --isolate", () => {
  let dir: string | undefined;

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  test("does not carry TZ or a live event-loop monitor between files", async () => {
    dir = await mkdtemp(join(tmpdir(), "bun-isolate-"));
    await writeFile(join(dir, "01-a.test.ts"), FILE_A);
    await writeFile(join(dir, "02-b.test.ts"), FILE_B);

    const env = { ...process.env };
    delete env.TZ;
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        "--isolate",
        "01-a.test.ts",
        "02-b.test.ts",
      ],
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });

    // Bun writes the test summary to stderr when stdout is a pipe, so join both.
    const output = proc.stdout.toString() + proc.stderr.toString();
    // File A's sentinel proves B ran second; the TZ and monitor checks live in B.
    expect(proc.exitCode, output).toBe(0);
    expect(output).toContain("2 pass");
  }, 30_000);
});
