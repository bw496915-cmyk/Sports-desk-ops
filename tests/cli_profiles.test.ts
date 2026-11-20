/**
 * @file tests/cli_profiles.test.ts
 * @description The CLI customer-profile surface: the matrix, a single profile's
 * timeline/comparison, and flag validation. Spawned end to end because the
 * command delegates to the terminal engine.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli", "sportsdesk_cli.ts");

function run(args: readonly string[]): {
  readonly code: number;
  readonly out: string;
  readonly err: string;
} {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "run", CLI, ...args],
    cwd: ROOT,
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

describe("sportsdesk CLI profiles", () => {
  test("matrix --json honors --limit", () => {
    const { code, out, err } = run(["profiles", "--limit", "3", "--json"]);

    expect(err).toBe("");
    expect(code).toBe(0);
    const rows = JSON.parse(out) as Array<{ id: string }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.id).toBeTruthy();
  });

  test("single profile timeline", () => {
    const { code, out } = run(["profiles", "GP301", "--timeline"]);

    expect(code).toBe(0);
    expect(out).toContain("TICKET TIMELINE");
    expect(out).toContain("TOTAL");
  });

  test("compare --json returns both sides", () => {
    const { code, out } = run([
      "profiles",
      "GP301",
      "--compare",
      "BRT5229",
      "--json",
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      left: { id: "GP301" },
      right: { id: "BRT5229" },
    });
  });

  test("invalid sort exits non-zero", () => {
    const { code, out } = run(["profiles", "--sort", "profit"]);

    expect(code).toBe(1);
    expect(out).toContain("--sort must be one of");
  });
});
