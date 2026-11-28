/**
 * @file tests/bun_fmt_staged.test.ts
 * @description Pin the git-hook contract behind `.githooks/pre-commit`:
 * `bun fmt --staged` formats and re-stages staged files, refuses a file that
 * also has unstaged edits (exit 2, untouched), and exits 0 with nothing staged.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
const GIT_ENV = {
  ...Bun.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-fmt-staged-"));
  dirs.push(dir);
  expect(git(dir, ["init", "-q"]).code).toBe(0);
  expect(git(dir, ["config", "user.email", "test@example.com"]).code).toBe(0);
  expect(git(dir, ["config", "user.name", "Test"]).code).toBe(0);
  return dir;
}

function git(
  dir: string,
  args: readonly string[],
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: dir,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

function fmtStaged(dir: string): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "fmt", "--staged"],
    cwd: dir,
    env: { ...GIT_ENV, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

describe("bun fmt --staged", () => {
  test("formats a staged file and stages the result", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "const a={b:1}\n");
    expect(git(dir, ["add", "a.ts"]).code).toBe(0);

    const result = fmtStaged(dir);

    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe(
      "const a = { b: 1 };\n",
    );
    expect(git(dir, ["show", ":a.ts"]).out).toBe("const a = { b: 1 };\n");
  });

  test("refuses a file with both staged and unstaged changes", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "const a = { b: 1 };\n");
    expect(git(dir, ["add", "a.ts"]).code).toBe(0);
    expect(git(dir, ["commit", "-qm", "base"]).code).toBe(0);

    writeFileSync(join(dir, "a.ts"), "const a={b:2}\n");
    expect(git(dir, ["add", "a.ts"]).code).toBe(0);
    writeFileSync(join(dir, "a.ts"), "const a = { b: 3 };\n");

    const result = fmtStaged(dir);

    expect(result.code).toBe(2);
    expect(result.err).toContain("both staged and unstaged changes");
    expect(git(dir, ["show", ":a.ts"]).out).toBe("const a={b:2}\n");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe(
      "const a = { b: 3 };\n",
    );
  });

  test("exits 0 when nothing is staged", () => {
    const dir = repo();
    writeFileSync(join(dir, "base.ts"), "const a = 1;\n");
    expect(git(dir, ["add", "base.ts"]).code).toBe(0);
    expect(git(dir, ["commit", "-qm", "base"]).code).toBe(0);

    const result = fmtStaged(dir);

    expect(result.code).toBe(0);
    expect(result.err).toContain("No staged files");
  });
});
