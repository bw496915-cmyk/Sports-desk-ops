#!/usr/bin/env bun
/** Backfill xml_golden_ast_sha256 + bun_version on ingestion JSONL (Plane 1 pins). */

import { resolve } from "node:path";
import { enrichIngestionJsonlRowWithXmlGoldenAst } from "../lib/bun_xml_golden_ast_replay.ts";

async function main(): Promise<number> {
  const inPath = process.argv[2]?.trim();
  const outPath = process.argv[3]?.trim();
  if (!inPath) {
    console.error(
      "usage: enrich_ingestion_jsonl_xml_golden <in.jsonl> [out.jsonl]",
    );
    return 1;
  }
  const input = resolve(inPath);
  const output = outPath ? resolve(outPath) : input;
  const text = await Bun.file(input).text();
  const lines = text.split("\n");
  const outLines: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { xml?: string };
    if (typeof row.xml !== "string") {
      outLines.push(line);
      continue;
    }
    outLines.push(
      JSON.stringify(
        enrichIngestionJsonlRowWithXmlGoldenAst(row as { xml: string }),
      ),
    );
  }
  await Bun.write(output, `${outLines.join("\n")}\n`);
  console.log(
    `enrich_ingestion_jsonl_xml_golden: ${outLines.length} lines → ${output}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
