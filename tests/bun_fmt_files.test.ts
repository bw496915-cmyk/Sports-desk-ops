/**
 * @file tests/bun_fmt_files.test.ts
 * @description Pin `bun fmt --list-files`, the coverage audit: it lists the
 * files the formatter owns and must omit the configured ignorePatterns plus
 * `.gitignore`d trees such as node_modules.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function listFiles(): string[] {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "fmt", "--list-files"],
    cwd: ROOT,
    env: { ...Bun.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString().split("\n").filter(Boolean);
}

describe("bun fmt --list-files", () => {
  test("includes tracked sources and omits configured ignores", () => {
    const files = listFiles();

    expect(files.length).toBeGreaterThan(1_000);
    expect(files).toContain("lib/console_depth.ts");

    // `[fmt].ignorePatterns` in bunfig.toml: exact bytes are pinned/generated.
    expect(files).not.toContain("data/agent-tree.json");
    expect(
      files.some(
        (file) =>
          file.startsWith("verification/manager-boot-oracle/pinned/") &&
          file.endsWith(".js"),
      ),
    ).toBe(false);
    expect(
      files.some((file) =>
        file.startsWith("tests/fixtures/fantasy402-sport-catalog-"),
      ),
    ).toBe(false);

    // .gitignore'd trees never enter the list.
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(files.some((file) => file.startsWith("dist/"))).toBe(false);
  });
});
