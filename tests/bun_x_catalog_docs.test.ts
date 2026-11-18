/**
 * @file tests/bun_x_catalog_docs.test.ts
 * @description `cli/README.md` is the operator-facing `bun x` catalog; it must not drift
 * from the root `package.json` `bin` map.
 *
 * The runtime gate (`tests/bunx_cli_root_layout.test.ts`) covers shims and execution; this
 * covers the documentation table and its prose count, which nothing else parses.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

async function declaredBins(): Promise<Record<string, string>> {
  const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
    bin?: Record<string, string>;
  };
  return pkg.bin ?? {};
}

describe("bun x catalog documentation", () => {
  test("cli/README.md rows match the root bin map exactly", async () => {
    const bins = Object.keys(await declaredBins()).sort();
    const readme = await Bun.file(join(ROOT, "cli/README.md")).text();
    const rows = [...readme.matchAll(/^\| `bun x ([a-z0-9-]+)`/gm)].map(
      (match) => match[1]!,
    );

    expect(bins.length).toBeGreaterThan(20);
    expect(rows.length).toBe(bins.length);
    expect(new Set(rows).size).toBe(rows.length);
    expect([...rows].sort()).toEqual(bins);
  });

  test("the README's mapping count is derived from the bin map", async () => {
    const bins = Object.keys(await declaredBins()).sort();
    const readme = await Bun.file(join(ROOT, "cli/README.md")).text();
    const count = /all (\d+) workspace CLI mappings/.exec(readme);
    expect(count?.[1]).toBe(String(bins.length));
  });

  test("every documented target exists and carries a shebang", async () => {
    for (const [bin, target] of Object.entries(await declaredBins())) {
      const file = Bun.file(join(ROOT, target));
      expect(await file.exists()).toBe(true);
      const head = (await file.text()).split("\n")[0] ?? "";
      expect(head.startsWith("#!/usr/bin/env "), `${bin} (${target})`).toBe(
        true,
      );
    }
  });
});
