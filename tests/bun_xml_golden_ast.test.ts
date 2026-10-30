import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUN_XML_GOLDEN_AST_EXAMPLES,
  goldenAstFingerprintFromExample,
  goldenAstFingerprintFromXml,
  goldenAstTextFromXml,
} from "../lib/bun_xml_golden_ast.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures/bun-xml-golden-ast");
const DOMAIN_JSONL = join(
  import.meta.dir,
  "fixtures/ingestion-replay-domain.jsonl",
);

describe("bun_xml_golden_ast", () => {
  for (const example of BUN_XML_GOLDEN_AST_EXAMPLES) {
    test(`golden pin ${example.id}`, () => {
      const ast = readFileSync(
        join(FIXTURE_DIR, `${example.id}.golden.ast.json5`),
        "utf8",
      ).trim();
      const sha = readFileSync(
        join(FIXTURE_DIR, `${example.id}.golden.sha256`),
        "utf8",
      ).trim();
      const xml = readFileSync(join(FIXTURE_DIR, `${example.id}.xml`), "utf8");
      expect(xml).toBe(example.xml);
      const live = goldenAstFingerprintFromExample(example);
      expect(live.astText).toBe(ast);
      expect(live.sha256).toBe(sha);
    });
  }

  test("ingestion-replay-domain.jsonl XML rows match golden AST pins", () => {
    const lines = readFileSync(DOMAIN_JSONL, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const pins = new Map<string, string>();
    for (const line of lines) {
      const row = JSON.parse(line) as { xml?: string };
      if (typeof row.xml !== "string") continue;
      pins.set(row.xml, goldenAstFingerprintFromXml(row.xml).sha256);
    }
    expect(pins.get("<t><p>100</p></t>")).toBe(
      readFileSync(
        join(FIXTURE_DIR, "sportsdesk-board-price-100.golden.sha256"),
        "utf8",
      ).trim(),
    );
    expect(pins.get("<t><p>250</p></t>")).toBe(
      readFileSync(
        join(FIXTURE_DIR, "sportsdesk-board-price-spike-250.golden.sha256"),
        "utf8",
      ).trim(),
    );
    expect(pins.size).toBe(9);
    for (const [xml, sha] of pins) {
      expect(goldenAstTextFromXml(xml).length).toBeGreaterThan(10);
      expect(sha).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
