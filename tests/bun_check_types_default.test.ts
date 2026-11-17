/**
 * @file tests/bun_check_types_default.test.ts
 * @description `bun check` behaves like TypeScript 7 for the `types` default: @types/* are no
 * longer auto-included, so a project that relies on auto-discovery cannot see `Bun`.
 *
 * Measured on Bun 1.4.4 against the pinned @types/bun. The assertion is deliberately about the
 * failure mode and the documented fix, because that is what a TypeScript 6/7 upgrade changes.
 * Source of the claim: the Bun "TypeScript 6 and 7" page (types defaults to an empty array;
 * `bun check` behaves like TypeScript 7 regardless of the installed `typescript`).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const ROOT = mkdtempSync(join(tmpdir(), "bun-check-types-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A minimal Bun-global project; `types` omitted reproduces the auto-discovery default. */
async function writeProject(types: readonly string[] | null): Promise<void> {
  await Bun.write(
    join(ROOT, "package.json"),
    '{"name":"probe","private":true}\n',
  );
  await Bun.write(
    join(ROOT, "probe.ts"),
    "const v: string = Bun.version;\nvoid v;\n",
  );
  await Bun.write(
    join(ROOT, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext"],
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          ...(types === null ? {} : { types }),
        },
        include: ["probe.ts"],
      },
      null,
      2,
    ),
  );
}

function check(): { exitCode: number; output: string } {
  const result = Bun.spawnSync(
    [process.execPath, "check", "--no-script", "-p", "tsconfig.json"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

test("bun check enforces the TS 7 types default", async () => {
  // @types/bun must be resolvable for the fix to be meaningful; reuse the installed one.
  symlinkSync(join(REPO, "node_modules"), join(ROOT, "node_modules"), "dir");

  await writeProject(null);
  const without = check();
  expect(without.exitCode).not.toBe(0);
  expect(without.output).toContain("Cannot find name 'Bun'");

  await writeProject(["bun"]);
  const withTypes = check();
  expect(withTypes.exitCode).toBe(0);
});
