/**
 * @file tests/cli_terminal_profile.test.ts
 * @description The read-only terminal profile inspector: seeded profiles,
 * per-profile depth/settings, and a missing store reported as MISSING rather
 * than zero profiles.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutomatedDualTokenStore } from "../lib/token_automation.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli", "terminal_profile.ts");
const dirs: string[] = [];

function seededDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "terminal-profile-"));
  dirs.push(dir);
  const dbPath = join(dir, "theme-tokens.sqlite");
  const store = new AutomatedDualTokenStore(dbPath);
  store.setConsoleDepth("default", 5);
  store.close();
  return dbPath;
}

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

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

describe("terminal_profile CLI", () => {
  test("reports seeded profiles and the stored console depth", () => {
    const dbPath = seededDb();
    const { code, out, err } = run(["--db", dbPath, "--json"]);

    expect(err).toBe("");
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      db: { exists: boolean; schema: boolean | null };
      count: number;
      profiles: Array<{
        id: string;
        consoleDepth: number | string;
        tokenCount: number;
        themeCount: number;
      }>;
    };
    expect(report.db.exists).toBe(true);
    expect(report.db.schema).toBe(true);
    expect(report.count).toBeGreaterThan(0);

    const def = report.profiles.find((profile) => profile.id === "default");
    expect(def?.consoleDepth).toBe(5);
    expect(def?.tokenCount).toBeGreaterThan(0);
  });

  test("filters to one profile", () => {
    const dbPath = seededDb();
    const { code, out } = run([
      "--db",
      dbPath,
      "--profile",
      "default",
      "--json",
    ]);

    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      count: number;
      profiles: Array<{ id: string }>;
    };
    expect(report.count).toBe(1);
    expect(report.profiles[0]?.id).toBe("default");
  });

  test("a missing store is MISSING, not zero profiles", () => {
    const missing = join(tmpdir(), `no-such-profile-${randomUUID()}.sqlite`);
    const { code, out } = run(["--db", missing, "--json"]);

    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      db: { exists: boolean; schema: boolean | null };
      count: number;
    };
    expect(report.db.exists).toBe(false);
    expect(report.db.schema).toBeNull();
    expect(report.count).toBe(0);
  });

  test("rejects an unknown flag", () => {
    const { code, err } = run(["--bogus"]);

    expect(code).not.toBe(0);
    expect(err).toContain("unknown flag");
  });
});
