import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const RAW_DATABASE_RE = /\bnew\s+Database\s*\(/;

/** Sole production site for `new Database(` — all callers use openSportsdeskSqlite*. */
const ALLOWED_RAW_DATABASE = new Set(["lib/sportsdesk_sqlite.ts"]);

function listTsFilesUnder(dirRel: string): string[] {
  const abs = join(REPO_ROOT, dirRel);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const child = join(abs, name);
    const st = statSync(child);
    if (st.isDirectory()) {
      out.push(...listTsFilesUnder(join(dirRel, name)));
      continue;
    }
    if (name.endsWith(".ts")) out.push(join(dirRel, name));
  }
  return out;
}

function listRootSportsdeskClis(): string[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => name.startsWith("sportsdesk_") && name.endsWith(".ts"))
    .map((name) => name);
}

function findRawDatabaseOpens(relPath: string): number[] {
  if (ALLOWED_RAW_DATABASE.has(relPath)) return [];
  const content = readFileSync(join(REPO_ROOT, relPath), "utf8");
  const lines = content.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (RAW_DATABASE_RE.test(line)) hits.push(i + 1);
  }
  return hits;
}

describe("schema_sqlite_hygiene", () => {
  test("lib/ and sportsdesk_*.ts open SQLite only via sportsdesk_sqlite.ts", () => {
    const relPaths = [...listTsFilesUnder("lib"), ...listRootSportsdeskClis()];
    const violations: string[] = [];
    for (const rel of relPaths) {
      const norm = relative(REPO_ROOT, join(REPO_ROOT, rel)).replace(
        /\\/g,
        "/",
      );
      for (const line of findRawDatabaseOpens(norm)) {
        violations.push(`${norm}:${line}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
