/**
 * @file tests/bun_loaders.test.ts
 * @description Measured contract for Bun's built-in file-type loaders, on the pinned runtime.
 *
 * Source of the claim: the bundler page's loader table and "type" import-attribute note.
 * Everything here is measured on Bun 1.4.4, not inferred from the page. The audit row lives in
 * docs/bun-upstream-reference.md §"Upstream prose vs measured runtime". Re-run this file before
 * updating that row after a Bun bump.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "bun-loaders-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Minimal valid wasm: (module (func (export "f") (result i32) i32.const 42)). */
const WASM_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00,
  0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b,
]);

const files: ReadonlyArray<[string, string | Uint8Array]> = [
  ["a.txt", "hello"],
  ["a.md", "# hi"],
  ["a.markdown", "# hi"],
  ["a.yaml", "a: 1"],
  ["a.yml", "a: 1"],
  ["a.toml", "a = 1"],
  ["a.jsonc", '{"a":1,//c\n}'],
  ["a.json5", "{a:1}"],
  ["a.xml", "<a>1</a>"],
  ["a.html", "<p>hi</p>"],
  ["a.css", "body{color:red}"],
  ["a.sh", "echo hi"],
  ["a.wasm", WASM_MODULE],
];
for (const [name, content] of files) {
  await Bun.write(join(ROOT, name), content);
}

type ModuleShape = { default: unknown };

const load = async (name: string, type?: string): Promise<ModuleShape> =>
  type === undefined
    ? ((await import(join(ROOT, name))) as ModuleShape)
    : ((await import(join(ROOT, name), { with: { type } })) as ModuleShape);

describe("built-in loaders (Bun 1.4.4)", () => {
  test("data loaders produce their documented values", async () => {
    expect((await load("a.txt")).default).toBe("hello");
    expect((await load("a.yaml")).default).toEqual({ a: 1 });
    expect((await load("a.yml")).default).toEqual({ a: 1 });
    expect((await load("a.toml")).default).toEqual({ a: 1 });
    expect((await load("a.jsonc")).default).toEqual({ a: 1 });
    expect((await load("a.json5")).default).toEqual({ a: 1 });
    // XML leaf values are strings on 1.4.4, not numbers.
    expect((await load("a.xml")).default).toEqual({ a: "1" });
  });

  test("markdown renders to HTML, not raw markdown", async () => {
    expect((await load("a.md")).default).toBe("<h1>hi</h1>\n");
    expect((await load("a.markdown")).default).toBe("<h1>hi</h1>\n");
  });

  test("html and css default to bundle objects", async () => {
    const html = (await load("a.html")).default;
    const css = (await load("a.css")).default;
    expect(typeof html).toBe("object");
    expect(typeof css).toBe("object");
    expect(html).not.toBeNull();
    expect(css).not.toBeNull();
  });

  test("shell and wasm default to a path string, not a script or a Module", async () => {
    const sh = (await load("a.sh")).default;
    const wasm = (await load("a.wasm")).default;
    expect(typeof sh).toBe("string");
    expect(String(sh).endsWith("a.sh")).toBe(true);
    expect(typeof wasm).toBe("string");
    expect(String(wasm).endsWith("a.wasm")).toBe(true);
    expect(wasm instanceof WebAssembly.Module).toBe(false);
  });

  test("a valid type attribute overrides extension inference", async () => {
    // .md rendered as text is the raw source; .txt parsed as markdown is HTML.
    expect((await load("a.md", "text")).default).toBe("# hi");
    expect((await load("a.txt", "markdown")).default).toBe("<p>hello</p>\n");
  });

  test("an unknown type is not rejected; a fresh path falls back to inference", async () => {
    // Fresh path: no prior explicit-type load for u.md in this process.
    await Bun.write(join(ROOT, "u.md"), "# hi");
    expect((await load("u.md", "not-a-loader")).default).toBe("<h1>hi</h1>\n");
  });

  test("an unknown type after an explicit load reuses the earlier result", async () => {
    // Measured quirk on 1.4.4: the attribute name is not validated, and the fallback can hit
    // the earlier explicit-type result for the same path. Treat `type` as a closed set.
    await Bun.write(join(ROOT, "q.md"), "# hi");
    expect((await load("q.md", "text")).default).toBe("# hi");
    expect((await load("q.md", "not-a-loader")).default).toBe("# hi");
  });

  test("the sqlite loader returns a Database", async () => {
    const { Database } = await import("bun:sqlite");
    const path = join(ROOT, "a.db");
    const db = new Database(path, { create: true });
    db.exec("create table t(x); insert into t values (1);");
    db.close();
    const loaded = (await load("a.db", "sqlite")).default;
    expect(loaded).toBeInstanceOf(Database);
  });

  test("bun build --target bun bundles the set and emits wasm as an asset", async () => {
    const entry = join(ROOT, "entry.ts");
    await Bun.write(
      entry,
      [
        'import txt from "./a.txt" with { type: "text" };',
        'import md from "./a.md" with { type: "markdown" };',
        'import yaml from "./a.yaml" with { type: "yaml" };',
        'import toml from "./a.toml" with { type: "toml" };',
        'import jsonc from "./a.jsonc" with { type: "jsonc" };',
        'import json5 from "./a.json5" with { type: "json5" };',
        'import xml from "./a.xml" with { type: "xml" };',
        'import css from "./a.css" with { type: "css" };',
        'import html from "./a.html" with { type: "html" };',
        'import sh from "./a.sh" with { type: "sh" };',
        'import wasm from "./a.wasm" with { type: "wasm" };',
        "console.log(txt, md, yaml, toml, jsonc, json5, xml, css, html, sh, wasm);",
      ].join("\n"),
    );
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(ROOT, "out"),
      target: "bun",
    });
    expect(result.success).toBe(true);
    const paths = result.outputs.map((output) => output.path);
    expect(paths.some((path) => path.endsWith(".wasm"))).toBe(true);
    expect(paths.some((path) => path.endsWith(".js"))).toBe(true);
  });
});
