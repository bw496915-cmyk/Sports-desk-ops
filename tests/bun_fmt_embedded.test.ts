/**
 * @file tests/bun_fmt_embedded.test.ts
 * @description Pin `bun fmt`'s embedded-code support: a fenced TypeScript block
 * inside Markdown and a `<style>` block inside HTML must be formatted, not left
 * as raw text. A formatter regression would otherwise silently pass
 * `format:check` on already-formatted files while leaving new embedded code
 * unformatted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-fmt-embedded-"));
  dirs.push(dir);
  return dir;
}

function runFmt(dir: string): number {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "fmt"],
    cwd: dir,
    env: { ...Bun.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode ?? -1;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

describe("bun fmt embedded code", () => {
  test("formats a fenced TypeScript block inside Markdown", () => {
    const dir = scratch();
    const file = join(dir, "doc.md");
    writeFileSync(file, "# Demo\n\n```ts\nconst x={a:1,b:[1,2,3]}\n```\n");

    expect(runFmt(dir)).toBe(0);
    expect(readFileSync(file, "utf8")).toContain(
      "```ts\nconst x = { a: 1, b: [1, 2, 3] };\n```",
    );
  });

  test("formats a <style> block inside HTML", () => {
    const dir = scratch();
    const file = join(dir, "page.html");
    writeFileSync(
      file,
      "<style>body{color:red;background:white}</style><p>hi</p>\n",
    );

    expect(runFmt(dir)).toBe(0);
    const formatted = readFileSync(file, "utf8");
    expect(formatted).toContain("<style>\n  body {\n    color: red;");
    expect(formatted).toContain("background: white;");
  });
});
