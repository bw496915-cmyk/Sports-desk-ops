/**
 * @file tests/bun_fmt_paths.test.ts
 * @description Pin `bun fmt`'s file-selection surface: a named file formats
 * alone, globs select matches, `--ignore-pattern` skips during a scan, and an
 * unmatched pattern is an error unless explicitly allowed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-fmt-paths-"));
  dirs.push(dir);
  return dir;
}

function runFmt(
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

describe("bun fmt paths and globs", () => {
  test("a named file is formatted without touching siblings", () => {
    const dir = scratch();
    writeFileSync(join(dir, "a.ts"), "const a={b:1}\n");
    writeFileSync(join(dir, "b.ts"), "const b={c:1}\n");

    const result = runFmt(dir, ["a.ts"]);

    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe(
      "const a = { b: 1 };\n",
    );
    expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("const b={c:1}\n");
  });

  test("a glob formats only matching files", () => {
    const dir = scratch();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.ts"), "const a={b:1}\n");
    writeFileSync(join(dir, "sub", "c.ts"), "const c={d:1}\n");

    const result = runFmt(dir, ["sub/**/*.ts"]);

    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, "sub", "c.ts"), "utf8")).toBe(
      "const c = { d: 1 };\n",
    );
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const a={b:1}\n");
  });

  test("--ignore-pattern skips a matching file during a scan", () => {
    const dir = scratch();
    writeFileSync(join(dir, "a.ts"), "const a={b:2}\n");
    writeFileSync(join(dir, "b.ts"), "const b={c:1}\n");

    const result = runFmt(dir, ["--ignore-pattern", "b.ts"]);

    expect(result.code).toBe(0);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe(
      "const a = { b: 2 };\n",
    );
    expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("const b={c:1}\n");
  });

  test("an unmatched pattern errors unless allowed", () => {
    const dir = scratch();

    const strict = runFmt(dir, ["nomatch/**/*.ts"]);
    expect(strict.code).toBe(2);
    expect(strict.err).toContain("No files matching the pattern");

    const allowed = runFmt(dir, [
      "--no-error-on-unmatched-pattern",
      "nomatch/**/*.ts",
    ]);
    expect(allowed.code).toBe(0);
  });
});
