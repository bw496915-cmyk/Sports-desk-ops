import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function formatInTemp(ext: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-fmt-semantics-"));
  try {
    const path = join(dir, `fixture.${ext}`);
    writeFileSync(path, source);
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "fmt", path],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    return readFileSync(path, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bun fmt semantic preservation", () => {
  test("keeps CSS escapes and descendant selectors", () => {
    const out = formatInTemp(
      "css",
      ".a { font-family: Font\\ Awesome, serif; }\nx |b { color: red; }\n",
    );
    expect(out).toContain("Font\\ Awesome");
    expect(out).not.toContain("Font\\Awesome");
    expect(out).toContain("x |b");
    expect(out).not.toContain("x|b");
  });

  test("keeps Handlebars doctype and script comment lines", () => {
    const out = formatInTemp(
      "hbs",
      "<!DOCTYPE html>\n<div>{{value}}</div>\n<script>\n// keep this comment\nconst x = 1;\n</script>\n",
    );
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toMatch(/\/\/ keep this comment\s*\n\s*const x = 1;/);
    expect(out).not.toContain("// keep this comment const x = 1;");
  });
});
