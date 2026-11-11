import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("typescript compiler API imports", () => {
  for (const rel of ["lib/bun_shapes.ts", "bin/bun_types.ts"]) {
    test(rel, () => {
      const src = readFileSync(join(root, rel), "utf8");
      expect(src).toContain("typescript-compiler-legacy");
      expect(src).not.toMatch(/from ["']typescript["']/);
    });
  }
});
