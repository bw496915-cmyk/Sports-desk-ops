import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * GitHub Actions workflows through `Bun.YAML` (YAML 1.2).
 *
 * Release note: yes/no/on/off are strings, so a workflow's `on:` key parses as
 * the string "on" instead of YAML 1.1's boolean `true`. This test runs that rule
 * over the real workflow files, and doubles as a syntax guard for edits that
 * never reach a runner.
 */

async function workflowFiles(): Promise<string[]> {
  const listed = Bun.spawnSync(
    ["git", "ls-files", ".github/workflows/*.yml", ".github/workflows/*.yaml"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(listed.exitCode).toBe(0);
  return listed.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file !== "");
}

describe("GitHub Actions YAML under YAML 1.2", () => {
  test("every workflow parses and keeps `on` as a string key", async () => {
    const files = await workflowFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const doc = Bun.YAML.parse(
        await Bun.file(resolve(process.cwd(), file)).text(),
      );
      expect(Array.isArray(doc)).toBe(false);
      const workflow = doc as Record<string, unknown>;

      // YAML 1.2 keeps `on` a string; 1.1 would coerce the key to boolean true.
      expect(Object.keys(workflow)).toContain("on");
      expect(workflow).not.toHaveProperty("true");
      expect(["string", "object"]).toContain(typeof workflow["on"]);

      expect(typeof workflow["jobs"]).toBe("object");
      expect(workflow["jobs"]).not.toBeNull();
    }
  });
});
