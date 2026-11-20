/**
 * @file tests/bun_fmt_stdin.test.ts
 * @description Pin `bun fmt`'s stdin mode: `--parser` selects the language
 * when there is no path, `--stdin-filepath` selects it from the name, `[fmt]`
 * config still applies, and nothing is written to disk.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-fmt-stdin-"));
  dirs.push(dir);
  return dir;
}

function formatStdin(
  dir: string,
  args: readonly string[],
  input: string,
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "fmt", ...args],
    cwd: dir,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, NO_COLOR: "1" },
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

describe("bun fmt stdin", () => {
  test("--parser typescript formats piped source and writes nothing", () => {
    const dir = scratch();
    const result = formatStdin(
      dir,
      ["--parser", "typescript"],
      "const a={b:1}\n",
    );

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("const a = { b: 1 };");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("--stdin-filepath picks the language from the path", () => {
    const dir = scratch();
    const result = formatStdin(
      dir,
      ["--stdin-filepath", "src/view.tsx"],
      'const a=<div className="x">hi</div>\n',
    );

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe('const a = <div className="x">hi</div>;');
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the [fmt] config still applies to stdin", () => {
    const dir = scratch();
    writeFileSync(join(dir, "bunfig.toml"), "[fmt]\nprintWidth = 30\n");
    const result = formatStdin(
      dir,
      ["--parser", "typescript"],
      "const config={alpha:1,beta:2,gamma:3,delta:4};\n",
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain("const config = {\n  alpha: 1,");
    expect(result.out).toContain("  delta: 4,\n};");
  });
});
