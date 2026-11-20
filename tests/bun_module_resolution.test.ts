/**
 * @file tests/bun_module_resolution.test.ts
 * @description Pin the module-resolution behaviors this repo relies on:
 * extensionless imports, TypeScript file-extension substitution (`.js` -> `.ts`,
 * `.mjs` -> `.mts`), and `?raw` imports. Each case runs a tiny project under the
 * current Bun binary, so CI exercises the pinned runtime.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-resolution-"));
  dirs.push(dir);
  return dir;
}

function run(
  dir: string,
  script: string,
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, script],
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

describe("module resolution", () => {
  test("an extensionless relative import resolves to .ts", () => {
    const dir = scratch();
    writeFileSync(join(dir, "hello.ts"), 'export const hello = "hi";\n');
    writeFileSync(
      join(dir, "index.ts"),
      'import { hello } from "./hello";\nconsole.log("extless:" + hello);\n',
    );

    const result = run(dir, "index.ts");

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("extless:hi");
  });

  test('a ".js" specifier resolves to the matching .ts source', () => {
    const dir = scratch();
    writeFileSync(join(dir, "a.ts"), "export const a = 42;\n");
    writeFileSync(
      join(dir, "js-spec.ts"),
      'import { a } from "./a.js";\nconsole.log("jstots:" + a);\n',
    );

    const result = run(dir, "js-spec.ts");

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("jstots:42");
  });

  test('a ".mjs" specifier resolves to the matching .mts source', () => {
    const dir = scratch();
    writeFileSync(join(dir, "m.mts"), "export const m = 7;\n");
    writeFileSync(
      join(dir, "mjs-spec.ts"),
      'import { m } from "./m.mjs";\nconsole.log("mjstomts:" + m);\n',
    );

    const result = run(dir, "mjs-spec.ts");

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("mjstomts:7");
  });

  test("?raw imports a file as text", () => {
    const dir = scratch();
    writeFileSync(join(dir, "data.txt"), "raw text\n");
    writeFileSync(
      join(dir, "raw.ts"),
      'import text from "./data.txt?raw";\nconsole.log("raw:" + text.trim());\n',
    );

    const result = run(dir, "raw.ts");

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("raw:raw text");
  });
});
