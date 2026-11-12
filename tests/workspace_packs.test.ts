import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  checkWorkspacePacks,
  parseBunPackDryRunFiles,
  WORKSPACE_PACK_DIRS,
} from "../scripts/check_workspace_packs.ts";

const ROOT = path.resolve(import.meta.dir, "..");

describe("workspace pack boundaries", () => {
  test("parses bun pm pack --dry-run file listing", () => {
    const sample = [
      "bun pack v1.4.4-canary.1",
      "",
      "packed 0.75KB package.json",
      "packed 1.00KB src/features.ts",
      "packed 253B src/index.ts",
      "",
      "Total files: 3",
    ].join("\n");

    expect(parseBunPackDryRunFiles(sample)).toEqual([
      "package.json",
      "src/features.ts",
      "src/index.ts",
    ]);
  });

  test("all @sportsdesk-ops workspace packages pass pack --dry-run and browser isolation checks", async () => {
    const report = await checkWorkspacePacks(ROOT);
    expect(report.entries.map((e) => e.dir)).toEqual([...WORKSPACE_PACK_DIRS]);
    expect(report.entries.flatMap((e) => e.issues)).toEqual([]);
    expect(report.ok).toBe(true);
    for (const entry of report.entries) {
      expect(entry.issues).toEqual([]);
      expect(entry.packedFiles).toContain("package.json");
      expect(entry.packedFiles).toContain("src/index.ts");
    }
  });
});
