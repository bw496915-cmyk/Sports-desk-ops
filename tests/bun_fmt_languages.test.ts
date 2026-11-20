/**
 * @file tests/bun_fmt_languages.test.ts
 * @description Pin `bun fmt`'s advertised language surface. One sample per
 * language must format without a parse error; representative samples must show
 * the formatter actually rewrote them (not just exit 0).
 *
 * Angular and Lightning Web Components use the HTML/TS/JS samples. Embedded
 * code (Markdown fences, HTML <style>, css`` templates) is covered by
 * bun_fmt_embedded.test.ts.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAMPLES: Readonly<Record<string, string>> = {
  "a.js": "const a={b:1}\n",
  "a.ts": "const a:number=1\n",
  "a.jsx": 'const a=<div className="x">hi</div>\n',
  "a.js.flow": "// @flow\nconst a: number = 1;\n",
  "a.css": "a{color:red}\n",
  "a.scss": "$c:red;a{color:$c}\n",
  "a.less": "@c:red;a{color:@c}\n",
  "a.html": '<div class="x">hi</div>\n',
  "a.vue": "<template><div>hi</div></template>\n",
  "a.svelte": "<script>let a=1;</script><div>{a}</div>\n",
  "a.mjml":
    "<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>\n",
  "a.json": '{"a":1}\n',
  "a.jsonc": '{"a":1,//c\n}\n',
  "a.json5": "{a:1,}\n",
  "a.yaml": "a: 1\n",
  "a.toml": "a=1\n",
  "a.md": "# hi\n\n```ts\nconst a=1\n```\n",
  "a.mdx": "# hi\n\n<div>x</div>\n",
  "a.graphql": "query Q { a }\n",
  "a.hbs": "<div>{{a}}</div>\n",
};

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-fmt-languages-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

test("formats every advertised language without a parse error", () => {
  const dir = scratch();
  for (const [name, content] of Object.entries(SAMPLES)) {
    writeFileSync(join(dir, name), content);
  }

  const proc = Bun.spawnSync({
    cmd: [process.execPath, "fmt"],
    cwd: dir,
    env: { ...Bun.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(proc.exitCode).toBe(0);

  for (const name of Object.keys(SAMPLES)) {
    expect(readFileSync(join(dir, name), "utf8").length).toBeGreaterThan(0);
  }

  // Representative rewrites, not merely a successful parse.
  expect(readFileSync(join(dir, "a.js"), "utf8")).toContain(
    "const a = { b: 1 };",
  );
  expect(readFileSync(join(dir, "a.css"), "utf8")).toContain("color: red;");
  expect(readFileSync(join(dir, "a.scss"), "utf8")).toContain("$c: red;");
  expect(readFileSync(join(dir, "a.json5"), "utf8")).toContain("{ a: 1 }");
  expect(readFileSync(join(dir, "a.graphql"), "utf8")).toContain(
    "query Q {\n  a\n}",
  );
});
