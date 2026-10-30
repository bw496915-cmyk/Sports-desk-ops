import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { assertAllowlistBypassNotInCi } from "../lib/schema_manifest_db_parity.ts";

const repoRoot = resolve(import.meta.dir, "..");
const snapshotScript = resolve(repoRoot, "scripts/schema_snapshot.ts");

describe("schema CI gate", () => {
  test("SPORTSDESK_SCHEMA_DUMP_ALLOWLIST_BYPASS forbidden when CI=true", () => {
    const prev = process.env.CI;
    process.env.CI = "true";
    try {
      expect(() =>
        assertAllowlistBypassNotInCi({ allowlistBypass: true }),
      ).toThrow(/forbidden in CI/);
    } finally {
      if (prev === undefined) delete process.env.CI;
      else process.env.CI = prev;
    }
  });

  test("schema:gate snapshot exits 0 under CI=true", async () => {
    const proc = Bun.spawn(
      ["bun", "run", snapshotScript],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "true",
          SPORTSDESK_SCHEMA_SNAPSHOT_QUIET: "1",
          SPORTSDESK_SCHEMA_SNAPSHOT_JSON: "/tmp/sportsdesk-schema-ci.snapshot.json",
          SPORTSDESK_SCHEMA_SNAPSHOT_BIN: "/tmp/sportsdesk-schema-ci.manifest.bin",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
