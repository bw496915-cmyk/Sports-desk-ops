import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  enrichIngestionJsonlRowWithXmlGoldenAst,
  exitCodeFromIngestionXmlGoldenAstStats,
  XML_GOLDEN_AST_REPLAY_DRIFT_EXIT,
} from "../lib/bun_xml_golden_ast_replay.ts";
import {
  replayIngestionExitCode,
  replaySportsdeskIngestionLog,
} from "../sportsdesk_ingestion_replay.ts";

describe("bun_xml_golden_ast_replay", () => {
  test("enrichIngestionJsonlRowWithXmlGoldenAst adds stable pin", () => {
    const row = enrichIngestionJsonlRowWithXmlGoldenAst({
      id: 1,
      v_t: 100,
      channel_id: "Internet",
      channel_status: "ACTIVE",
      xml: "<t><p>100</p></t>",
    });
    expect(row.xml_golden_ast_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.bun_version).toBe(Bun.version);
  });

  test("replay exit 4 when golden pin drifts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ing-golden-"));
    const path = join(dir, "log.jsonl");
    const good = enrichIngestionJsonlRowWithXmlGoldenAst({
      id: 1,
      v_t: 100,
      channel_id: "BLOCKED",
      channel_status: "DROPPED",
      v_to: 200,
      latency_ms: 10,
      xml: "<t><p>100</p></t>",
    });
    good.xml = "<t><p>999</p></t>";
    writeFileSync(path, `${JSON.stringify(good)}\n`);

    const result = await replaySportsdeskIngestionLog({ path });
    expect(result.xmlGoldenAst.drift).toBe(1);
    expect(replayIngestionExitCode(result)).toBe(
      XML_GOLDEN_AST_REPLAY_DRIFT_EXIT,
    );
    expect(exitCodeFromIngestionXmlGoldenAstStats(result.xmlGoldenAst)).toBe(4);
  });

  test("replay exit 0 when pin matches domain fixture row", async () => {
    const path = join(
      import.meta.dir,
      "fixtures/ingestion-replay-domain.jsonl",
    );
    const enrichedPath = join(
      mkdtempSync(join(tmpdir(), "ing-enrich-")),
      "e.jsonl",
    );
    const lines = (await Bun.file(path).text()).trim().split("\n");
    const out = lines
      .map((line) =>
        JSON.stringify(
          enrichIngestionJsonlRowWithXmlGoldenAst(
            JSON.parse(line) as { xml: string },
          ),
        ),
      )
      .join("\n");
    await Bun.write(enrichedPath, `${out}\n`);

    const result = await replaySportsdeskIngestionLog({ path: enrichedPath });
    expect(result.xmlGoldenAst.verified).toBe(9);
    expect(result.xmlGoldenAst.drift).toBe(0);
    expect(exitCodeFromIngestionXmlGoldenAstStats(result.xmlGoldenAst)).toBe(0);
  });
});
