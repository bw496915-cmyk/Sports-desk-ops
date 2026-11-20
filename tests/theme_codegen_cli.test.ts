import { afterEach, describe, expect, test } from "bun:test";
import { bunfigConsoleDepthFromDocument } from "../lib/token_automation.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "theme-codegen-"));
  dirs.push(dir);
  return dir;
}

function runCli(args: readonly string[]) {
  return Bun.spawnSync([process.execPath, "cli/theme_codegen.ts", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("theme codegen CLI", () => {
  test("writes both artifacts for a built-in profile", () => {
    const dir = scratch();
    const result = runCli([
      "codegen",
      "--profile",
      "crimson-dry",
      "--out-dir",
      join(dir, "out"),
      "--db",
      join(dir, "tokens.sqlite"),
    ]);

    expect(result.exitCode).toBe(0);
    const envFile = join(dir, "out", ".env.crimson-dry");
    const tsFile = join(dir, "out", "crimson-dry.theme.gen.ts");
    expect(existsSync(envFile)).toBe(true);
    expect(existsSync(tsFile)).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain(
      'PTY_PROFILE="crimson-dry"',
    );
    expect(readFileSync(tsFile, "utf8")).toContain(
      "GENERATED_PROFILE_CRIMSON_DRY",
    );
  });

  test("exits 2 for an unknown profile and prints the store error", () => {
    const dir = scratch();
    const result = runCli([
      "codegen",
      "--profile",
      "does-not-exist",
      "--out-dir",
      join(dir, "out"),
      "--db",
      join(dir, "tokens.sqlite"),
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("ERR_PROFILE_NOT_FOUND");
  });

  test("--depth is stored but emits the effective bunfig depth", async () => {
    const dir = scratch();
    const result = runCli([
      "codegen",
      "--profile",
      "crimson-dry",
      "--out-dir",
      join(dir, "out"),
      "--db",
      join(dir, "tokens.sqlite"),
      "--depth",
      "6",
    ]);

    expect(result.exitCode).toBe(0);
    const bunfigDepth = bunfigConsoleDepthFromDocument(
      Bun.TOML.parse(readFileSync(join(ROOT, "bunfig.toml"), "utf8")),
    );
    const env = readFileSync(join(dir, "out", ".env.crimson-dry"), "utf8");
    if (bunfigDepth === null) {
      expect(env).toContain('PTY_CONSOLE_DEPTH="6"');
      expect(result.stderr.toString()).not.toContain("WARN_DEPTH_OVERRIDDEN");
    } else {
      // Measured on 1.4.4: bunfig wins over both argv and BUN_OPTIONS.
      expect(env).toContain(`PTY_CONSOLE_DEPTH="${bunfigDepth}"`);
      expect(env).toContain(`BUN_OPTIONS="--console-depth=${bunfigDepth}"`);
      expect(result.stderr.toString()).toContain("WARN_DEPTH_OVERRIDDEN");
    }
  });

  test("--depth rejects a non-integer before writing", () => {
    const dir = scratch();
    const result = runCli([
      "codegen",
      "--profile",
      "default",
      "--out-dir",
      join(dir, "out"),
      "--db",
      join(dir, "tokens.sqlite"),
      "--depth",
      "6.5",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("ERR_DEPTH_INVALID");
    expect(existsSync(join(dir, "out", ".env.default"))).toBe(false);
  });

  test("exits 2 with usage when no subcommand is given", () => {
    const result = runCli([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "usage: bun cli/theme_codegen.ts codegen",
    );
  });
});
