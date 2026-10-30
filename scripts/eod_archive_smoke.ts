#!/usr/bin/env bun
/** CI smoke: tar.gz from fixture JSONL + temp SQLite; verify member hashes. */

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import {
  createEodTarGzFromPaths,
  sha256MembersInTarGz,
} from "../lib/eod_archive.ts";

async function main(): Promise<number> {
  const repo = resolve(import.meta.dir, "..");
  const jsonl = join(repo, "tests/fixtures/ingestion-replay-domain.jsonl");
  if (!(await Bun.file(jsonl).exists())) {
    console.error(`eod:smoke: missing ${jsonl}`);
    return 1;
  }

  const dir = mkdtempSync(join(tmpdir(), "eod-smoke-"));
  const dbPath = join(dir, "desk.sqlite");
  const out = join(dir, "EOD-smoke.tar.gz");

  const db = openSportsdeskSqlite(dbPath);
  db.exec(`
    CREATE TABLE ingestion_trades (
      id INTEGER PRIMARY KEY,
      qty INTEGER,
      note TEXT
    );
  `);
  db.close();

  await createEodTarGzFromPaths(out, [
    { archiveName: "audit/ingestion-replay-domain.jsonl", path: jsonl },
    { archiveName: "desk.sqlite", path: dbPath, sqlite: true },
  ]);

  const hashes = await sha256MembersInTarGz(out);
  if (!hashes.has("audit/ingestion-replay-domain.jsonl")) {
    console.error("eod:smoke: missing jsonl member in archive");
    return 1;
  }
  if (!hashes.has("desk.sqlite")) {
    console.error("eod:smoke: missing sqlite member in archive");
    return 1;
  }
  if (hashes.has("desk.sqlite-wal") || hashes.has("desk.sqlite-shm")) {
    console.error("eod:smoke: WAL sidecars must not be bundled");
    return 1;
  }

  console.log(
    JSON.stringify(
      {
        archive: out,
        members: Object.fromEntries(hashes),
      },
      null,
      2,
    ),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
