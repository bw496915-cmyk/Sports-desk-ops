/**
 * @file tests/bun_console_depth_precedence.test.ts
 * @description Pins the console-depth precedence measured on the Bun 1.4.4 pin:
 * a numeric `[console].depth` in bunfig wins over **both** a literal
 * `--console-depth` argv flag and `BUN_OPTIONS`. That is why `theme:codegen` emits
 * the bunfig value and warns when `--depth` disagrees, instead of pretending the
 * flag wins.
 *
 * If a future Bun changes the order, this fails and the emit strategy must be
 * re-checked rather than silently lying again. Each case runs in a temp directory
 * with its own bunfig, so it does not depend on the repository's config.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bun-console-depth-precedence-"));
const PROBE = "console.log({a:{b:{c:{d:{e:{f:{g:{h:{i:{j:1}}}}}}}}}})\n";
writeFileSync(join(dir, "probe.ts"), PROBE);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Inherit PATH etc., but never the caller's BUN_OPTIONS unless a case sets it. */
const BASE_ENV: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && key !== "BUN_OPTIONS") BASE_ENV[key] = value;
}

function run(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  bunfig: string,
): string {
  writeFileSync(join(dir, "bunfig.toml"), bunfig);
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: dir,
    env: { ...BASE_ENV, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `bun ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

test("bunfig [console].depth beats BUN_OPTIONS and argv on the pinned Bun", () => {
  const bunfig = "[console]\ndepth = 3\n";

  const viaEnv = run(
    ["run", "probe.ts"],
    { BUN_OPTIONS: "--console-depth=12" },
    bunfig,
  );
  expect(viaEnv).toContain("d: [Object ...]");
  expect(viaEnv).not.toContain("j: 1");

  const viaArgv = run(["--console-depth=12", "run", "probe.ts"], {}, bunfig);
  expect(viaArgv).not.toContain("j: 1");
});

test("without [console].depth both BUN_OPTIONS and argv take effect", () => {
  const bunfig = "[install]\nexact = true\n";

  expect(
    run(["run", "probe.ts"], { BUN_OPTIONS: "--console-depth=12" }, bunfig),
  ).toContain("j: 1");
  expect(run(["--console-depth=12", "run", "probe.ts"], {}, bunfig)).toContain(
    "j: 1",
  );
});
