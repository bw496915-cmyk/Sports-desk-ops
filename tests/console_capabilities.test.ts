/**
 * @file tests/console_capabilities.test.ts
 * @description Pins the Bun 1.4.4 Console surface this repo's depth work depends on,
 * in one place instead of one reference-page probe at a time:
 *
 *  - `[console].depth` applies to `console.log` and `console.debug`;
 *  - `console.dir(value, { depth })` overrides bunfig per call;
 *  - `console.table(rows, properties)` selects the named columns;
 *  - `console.profile`/`profileEnd` exist and are no-ops without an inspector;
 *  - `console` is async-iterable over stdin (`for await (const line of console)`);
 *  - `node:console`'s `Console` exists (the global and `Bun.Console` do not on
 *    1.4.4) and ignores bunfig unless `inspectOptions.depth` is given.
 *
 * If a Bun upgrade adds the global `Console` or changes these behaviours, the
 * failing case is the prompt to re-read the reference and update the matrix.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "console-capabilities-"));
const PROBE = `
import { Console as NodeConsole } from "node:console";
const v = { a: { b: { c: { d: { e: { f: 1 } } } } } };
const rows = [{ a: 1, b: "Y" }, { a: "Z", b: 2 }];

console.log("##globals", typeof (globalThis as unknown as { Console?: unknown }).Console,
  typeof (Bun as unknown as { Console?: unknown }).Console, typeof NodeConsole);
console.log("##async", typeof (console as unknown as Record<symbol, unknown>)[Symbol.asyncIterator]);
console.log("##log"); console.log(v);
console.log("##debug"); console.debug(v);
console.log("##dir8"); console.dir(v, { depth: 8 });
console.log("##dir1"); console.dir(v, { depth: 1 });
console.log("##table"); console.table(rows, ["a"]);
console.profile("capability");
console.profileEnd("capability");
console.log("##profile-ok");
console.log("##node-default");
new NodeConsole({ stdout: process.stdout }).log(v);
console.log("##node8");
new NodeConsole({ stdout: process.stdout, inspectOptions: { depth: 8 } }).log(v);
`;

let output = "";
let exitCode: number | null = null;

beforeAll(() => {
  writeFileSync(join(DIR, "probe.ts"), PROBE);
  writeFileSync(join(DIR, "bunfig.toml"), "[console]\ndepth = 3\n");
  const result = Bun.spawnSync([process.execPath, "run", "probe.ts"], {
    cwd: DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  output = result.stdout.toString();
  exitCode = result.exitCode;
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** One `##name` block, up to the next `##` marker. */
function section(name: string): string {
  const start = output.indexOf(`##${name}`);
  const next = output.indexOf("##", start + 2);
  return output.slice(start, next === -1 ? undefined : next);
}

describe("console capability matrix (Bun 1.4.4)", () => {
  test("the probe script itself exits cleanly", () => {
    expect(exitCode).toBe(0);
  });

  test("the global Console and Bun.Console are absent; node:console has one", () => {
    expect(section("globals")).toContain("undefined undefined function");
  });

  test("console exposes an async iterator", () => {
    expect(section("async")).toContain("function");
  });

  test("console is async-iterable over stdin", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'for await (const line of console) console.log("LINE:" + line);',
      ],
      {
        stdin: new TextEncoder().encode("alpha\nbeta\n"),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain("LINE:alpha");
    expect(out).toContain("LINE:beta");
  });

  test("[console].depth applies to log and debug", () => {
    for (const name of ["log", "debug"]) {
      const block = section(name);
      expect(block).toContain("d: [Object ...]");
      expect(block).not.toContain("e:");
    }
  });

  test("console.dir overrides bunfig per call", () => {
    expect(section("dir8")).toContain("f: 1");
    const shallow = section("dir1");
    expect(shallow).toContain("b: [Object ...]");
    expect(shallow).not.toContain("c:");
  });

  test("console.table selects only the requested properties", () => {
    const table = section("table");
    expect(table).toContain("│ a │");
    expect(table).not.toContain("│ b │");
  });

  test("console.profile is a no-op without an inspector", () => {
    expect(section("profile-ok")).toContain("##profile-ok");
  });

  test("node:console ignores bunfig unless inspectOptions.depth is given", () => {
    const nodeDefault = section("node-default");
    expect(nodeDefault).toContain("c: [Object]");
    expect(nodeDefault).not.toContain("d: {");

    expect(section("node8")).toContain("f: 1");
  });
});
