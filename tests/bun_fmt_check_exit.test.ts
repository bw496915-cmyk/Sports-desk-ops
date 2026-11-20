/**
 * @file tests/bun_fmt_check_exit.test.ts
 * @description Pin `bun fmt --check`'s CI contract: 0 when everything is
 * formatted, 1 when a file needs formatting (naming it), 2 on a syntax error.
 * `--list-different` prints only the offending names.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-fmt-check-"));
  dirs.push(dir);
  return dir;
}

function fmt(
  dir: string,
  args: readonly string[],
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "fmt", ...args],
    cwd: dir,
    env: { ...Bun.env, NO_COLOR: "1" },
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

test("--check exits 0 when the file is formatted", () => {
  const dir = scratch();
  writeFileSync(join(dir, "ok.ts"), "const a = 1;\n");

  const result = fmt(dir, ["--check", "ok.ts"]);

  expect(result.code).toBe(0);
  expect(result.out).toBe("");
});

test("--check exits 1 and names the file that needs formatting", () => {
  const dir = scratch();
  writeFileSync(join(dir, "bad.ts"), "const b={c:1}\n");

  const result = fmt(dir, ["--check", "bad.ts"]);

  expect(result.code).toBe(1);
  expect(result.out).toContain("bad.ts");
  expect(result.err).toContain("needs formatting");
});

test("--check exits 2 on a syntax error", () => {
  const dir = scratch();
  writeFileSync(join(dir, "syntax.ts"), "const =;\n");

  const result = fmt(dir, ["--check", "syntax.ts"]);

  expect(result.code).toBe(2);
  expect(result.out).toBe("");
  expect(result.err.length).toBeGreaterThan(0);
});

test("--list-different prints only the offending names", () => {
  const dir = scratch();
  writeFileSync(join(dir, "bad.ts"), "const b={c:1}\n");

  const result = fmt(dir, ["--list-different", "bad.ts"]);

  expect(result.code).toBe(1);
  expect(result.out.trim()).toBe("bad.ts");
  expect(result.err).toBe("");
});
