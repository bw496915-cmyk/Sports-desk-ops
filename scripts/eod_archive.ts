#!/usr/bin/env bun
/**
 * Build EOD tar.gz (audit JSONL + optional SQLite). WAL flushed; no -wal/-shm in bundle.
 *
 *   bun run eod:archive -- --out reports/EOD_2026-10-30.tar.gz audit.jsonl=./reports/ingestion-audit.jsonl
 *   bun run eod:archive -- --out bundle.tar.gz desk.sqlite=./data/desk.sqlite
 */

import { resolve } from "node:path";
import {
  collectEodArchiveMembers,
  createEodTarGzFromPaths,
  sha256HexBytes,
  type EodArchiveMemberSpec,
} from "../lib/eod_archive.ts";

function parseMemberArg(raw: string): EodArchiveMemberSpec {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(`expected archiveName=path, got: ${raw}`);
  }
  const archiveName = raw.slice(0, eq).trim();
  const path = resolve(raw.slice(eq + 1).trim());
  return { archiveName, path };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const outArg = args.find((a) => a.startsWith("--out="))?.slice("--out=".length);
  const outPath = outArg?.trim();
  if (!outPath) {
    console.error("eod:archive: --out=path.tar.gz required");
    console.error("members: archiveName=/abs/path ...");
    return 1;
  }

  const memberArgs = args.filter((a) => !a.startsWith("-"));
  if (memberArgs.length === 0) {
    console.error("eod:archive: pass at least one archiveName=path member");
    return 1;
  }

  const members = memberArgs.map(parseMemberArg);
  const written = await createEodTarGzFromPaths(resolve(outPath), members);
  const payload = await collectEodArchiveMembers(members);
  const manifest = {
    captured_at: new Date().toISOString(),
    destination: resolve(outPath),
    bytes_written: written,
    members: Object.fromEntries(
      Object.entries(payload).map(([name, bytes]) => [
        name,
        { bytes: bytes.byteLength, sha256: sha256HexBytes(bytes) },
      ]),
    ),
  };
  console.log(JSON.stringify(manifest, null, 2));
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
