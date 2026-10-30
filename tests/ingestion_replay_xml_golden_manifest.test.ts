import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenAstFingerprintFromXml } from "../lib/bun_xml_golden_ast.ts";

const manifestPath = join(
  import.meta.dir,
  "fixtures/ingestion-replay-domain-xml-golden.json",
);

type Manifest = {
  bun_version: string;
  entries: { xml: string; sha256: string }[];
};

describe("ingestion_replay_xml_golden_manifest", () => {
  test("committed manifest matches live AST fingerprints", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(manifest.entries.length).toBe(9);
    for (const entry of manifest.entries) {
      expect(goldenAstFingerprintFromXml(entry.xml).sha256).toBe(entry.sha256);
    }
  });
});
