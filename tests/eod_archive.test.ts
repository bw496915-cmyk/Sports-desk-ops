import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEodTarGzFromPaths,
  sha256HexBytes,
  sha256MembersInTarGz,
} from "../lib/eod_archive.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

describe("eod_archive", () => {
  test("createEodTarGz bundles jsonl and omits wal sidecars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eod-"));
    const jsonl = join(dir, "audit.jsonl");
    writeFileSync(jsonl, '{"id":1}\n');

    const dbPath = join(dir, "desk.sqlite");
    const db = openSportsdeskSqlite(dbPath);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
    db.close();

    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;

    const out = join(dir, "EOD.tar.gz");
    await createEodTarGzFromPaths(out, [
      { archiveName: "audit.jsonl", path: jsonl },
      { archiveName: "desk.sqlite", path: dbPath, sqlite: true },
    ]);

    const hashes = await sha256MembersInTarGz(out, "*");
    expect(hashes.has("audit.jsonl")).toBe(true);
    expect(hashes.has("desk.sqlite")).toBe(true);
    expect(hashes.has("desk.sqlite-wal")).toBe(false);
    expect(hashes.has("desk.sqlite-shm")).toBe(false);

    if (await Bun.file(walPath).exists()) {
      expect(hashes.get("desk.sqlite")).not.toBe(
        sha256HexBytes(await Bun.file(walPath).bytes()),
      );
    }
    void shmPath;
  });
});
