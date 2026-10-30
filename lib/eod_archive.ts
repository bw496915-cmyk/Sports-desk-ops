/**
 * EOD tar.gz bundles via Bun.Archive (gzip level from lib/archive_policy.ts).
 *
 * Large verify: use extract() — `.files()` loads the whole archive into memory.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHIVE_COMPRESS } from "./archive_policy.ts";
import {
  openSportsdeskSqlite,
  truncateWalAndDisablePersist,
} from "./sportsdesk_sqlite.ts";

export { ARCHIVE_COMPRESS };

/** Prefer extract-based verify above this compressed size (bytes). */
export const EOD_ARCHIVE_EXTRACT_VERIFY_BYTES = 32 * 1024 * 1024;

export type EodArchiveMemberSpec = {
  /** Path inside the tar (e.g. audit/trading_desk_audit.jsonl). */
  archiveName: string;
  /** Filesystem source. */
  path: string;
  /** Flush WAL into the main file before read (default for .sqlite/.db). */
  sqlite?: boolean;
};

export function flushSqliteWalForArchive(dbPath: string): void {
  const db = openSportsdeskSqlite(dbPath);
  try {
    truncateWalAndDisablePersist(db);
  } finally {
    db.close();
  }
}

function isSqlitePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".sqlite") || lower.endsWith(".db");
}

export async function collectEodArchiveMembers(
  members: readonly EodArchiveMemberSpec[],
): Promise<Record<string, Uint8Array>> {
  const payload: Record<string, Uint8Array> = {};
  for (const member of members) {
    const file = Bun.file(member.path);
    if (!(await file.exists())) {
      throw new Error(`eod archive: missing ${member.path}`);
    }
    const sqlite = member.sqlite ?? isSqlitePath(member.path);
    if (sqlite) {
      flushSqliteWalForArchive(member.path);
    }
    payload[member.archiveName] = await file.bytes();
  }
  return payload;
}

export async function writeEodTarGz(
  destination: string,
  members: Record<string, Uint8Array>,
): Promise<number> {
  const archive = new Bun.Archive(members, ARCHIVE_COMPRESS);
  return Bun.write(destination, archive);
}

export async function createEodTarGzFromPaths(
  destination: string,
  members: readonly EodArchiveMemberSpec[],
): Promise<number> {
  const payload = await collectEodArchiveMembers(members);
  return writeEodTarGz(destination, payload);
}

export function sha256HexBytes(bytes: Uint8Array): string {
  return Bun.CryptoHasher.hash("sha256", bytes, "hex");
}

/**
 * Hash selected members. Uses `.files(glob)` when small; `extract()` when large.
 */
export async function sha256MembersInTarGz(
  archivePath: string,
  /** `*` only matches tar root; use `**` for nested paths (e.g. audit/*.jsonl). */
  glob = "**",
): Promise<Map<string, string>> {
  const stat = await Bun.file(archivePath).stat();
  const bytes = await Bun.file(archivePath).bytes();
  const archive = new Bun.Archive(bytes);

  if (stat.size <= EOD_ARCHIVE_EXTRACT_VERIFY_BYTES) {
    const selected = await archive.files(glob);
    const out = new Map<string, string>();
    const entries =
      selected instanceof Map
        ? selected.entries()
        : Object.entries(selected as Record<string, unknown>);
    for (const [name, content] of entries) {
      const buf =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content instanceof Uint8Array
            ? content
            : content instanceof Blob
              ? new Uint8Array(await content.arrayBuffer())
              : new Uint8Array(
                  await new Blob([content as BlobPart]).arrayBuffer(),
                );
      out.set(name, sha256HexBytes(buf));
    }
    return out;
  }

  const dir = mkdtempSync(join(tmpdir(), "eod-verify-"));
  try {
    await archive.extract(dir);
    const out = new Map<string, string>();
    const globber = new Bun.Glob(glob);
    for await (const rel of globber.scan({ cwd: dir, onlyFiles: true })) {
      const full = join(dir, rel);
      const fileBytes = await Bun.file(full).bytes();
      out.set(rel.replaceAll("\\", "/"), sha256HexBytes(fileBytes));
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
