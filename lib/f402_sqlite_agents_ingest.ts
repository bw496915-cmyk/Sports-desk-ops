/**
 * Flatten portal hierarchy → `agents` SQLite table (manager boot).
 */

import type { Database } from "bun:sqlite";

import {
  runBaseHeriarchyParserWithAgentMap,
  type PortalHierarchyParserContext,
} from "./f402_portal_hierarchy_parser.ts";
import type { PortalGeneralRow } from "./f402_portal_hierarchy_oracle.ts";
import { openSportsdeskSqlite, sqlInt } from "./sportsdesk_sqlite.ts";

export interface FlatAgentRow {
  readonly agent_id: string;
  readonly login: string;
  readonly level: number;
  readonly agent_type: string;
  readonly seq_number: number | null;
  readonly parent_id: string | null;
}

export const AGENTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    level INTEGER NOT NULL,
    agent_type TEXT NOT NULL,
    seq_number INTEGER,
    parent_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_id);
  CREATE INDEX IF NOT EXISTS idx_agents_level ON agents(level);
`;

/** Depth-first agent tree via recursive CTE (UI-ready ordering). */
export const AGENT_TREE_RECURSIVE_SQL = `
WITH RECURSIVE agent_tree(
  agent_id, login, level, agent_type, seq_number, parent_id, depth
) AS (
  SELECT agent_id, login, level, agent_type, seq_number, parent_id, 1
  FROM agents
  WHERE level = 1
  UNION ALL
  SELECT a.agent_id, a.login, a.level, a.agent_type, a.seq_number, a.parent_id, t.depth + 1
  FROM agents a
  JOIN agent_tree t ON a.parent_id = t.agent_id
)
SELECT * FROM agent_tree ORDER BY depth, seq_number, agent_id;
`;

function isNestedAgentNode(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "AgentID" in value &&
    "Level" in value
  );
}

function walkNestedAgentNode(
  node: Record<string, unknown>,
  parentId: string | null,
  out: FlatAgentRow[],
): void {
  const agentId = String(node.AgentID).trim();
  const loginRaw = node.Login;
  const login =
    loginRaw === undefined || loginRaw === null
      ? agentId
      : String(loginRaw).trim();
  const level = Number(node.Level);
  const agentType = String(node.AgentType ?? "");
  const seqRaw = node.SeqNumber;
  const seq_number =
    seqRaw === undefined || seqRaw === null ? null : Number(seqRaw);

  out.push({
    agent_id: agentId,
    login,
    level,
    agent_type: agentType,
    seq_number,
    parent_id: parentId,
  });

  for (const value of Object.values(node)) {
    if (isNestedAgentNode(value)) {
      walkNestedAgentNode(value, agentId, out);
    }
  }
}

/**
 * Walk `normalizeNested(runBaseHeriarchyParser(…))` (nested map, not `children[]`).
 * Dedupes by `agent_id` (first parent wins). Prefer {@link flatAgentsFromPortalParse}
 * when GENERAL rows are available — trie-shaped trees can revisit nodes on multiple paths.
 */
export function flattenNormalizedHierarchyTree(tree: unknown): FlatAgentRow[] {
  const raw: FlatAgentRow[] = [];
  if (!isNestedAgentNode(tree) && typeof tree === "object" && tree !== null) {
    for (const value of Object.values(tree as Record<string, unknown>)) {
      if (isNestedAgentNode(value)) {
        walkNestedAgentNode(value, null, raw);
      }
    }
  } else if (isNestedAgentNode(tree)) {
    walkNestedAgentNode(tree, null, raw);
  }
  const byId = new Map<string, FlatAgentRow>();
  for (const row of raw) {
    if (!byId.has(row.agent_id)) {
      byId.set(row.agent_id, row);
    }
  }
  return [...byId.values()];
}

export function flatAgentsFromPortalParse(
  general: readonly PortalGeneralRow[],
  ctx: PortalHierarchyParserContext,
): FlatAgentRow[] {
  const { agentMap } = runBaseHeriarchyParserWithAgentMap(general, ctx);
  const rows: FlatAgentRow[] = [];
  for (const row of general) {
    const agentId = String(row.AgentID).trim();
    const entry = agentMap[agentId];
    if (entry === undefined) {
      // Parser port matches pinned baseHeriarchy (levels 1–12 only).
      continue;
    }
    const level = Number(row.Level);
    const seqRaw = row.SeqNumber;
    rows.push({
      agent_id: agentId,
      login: String(row.Login).trim(),
      level,
      agent_type: String(row.AgentType),
      seq_number:
        seqRaw === undefined || seqRaw === null ? null : Number(seqRaw),
      parent_id: level === 1 ? null : String(entry.Master).trim(),
    });
  }
  return rows;
}

export function ensureAgentsSchema(db: Database): void {
  db.exec(AGENTS_TABLE_DDL);
}

export function ingestFlatAgentsWithTiming(
  db: Database,
  rows: readonly FlatAgentRow[],
): { readonly rowCount: number; readonly ingestMs: number } {
  ensureAgentsSchema(db);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO agents
    (agent_id, login, level, agent_type, seq_number, parent_id)
    VALUES ($agent_id, $login, $level, $agent_type, $seq_number, $parent_id)
  `);
  const insertAll = db.transaction((batch: readonly FlatAgentRow[]) => {
    for (const row of batch) {
      insert.run({
        $agent_id: row.agent_id,
        $login: row.login,
        $level: row.level,
        $agent_type: row.agent_type,
        $seq_number: row.seq_number,
        $parent_id: row.parent_id,
      });
    }
  });
  const t0 = Bun.nanoseconds();
  insertAll(rows);
  const ingestMs = (Bun.nanoseconds() - t0) / 1_000_000;
  const countRow = db.query("SELECT count(*) AS c FROM agents").get() as {
    c: number | bigint;
  };
  return { rowCount: sqlInt(countRow.c), ingestMs };
}

export function countAgentTreeCteRows(db: Database): number {
  const rows = db.query(AGENT_TREE_RECURSIVE_SQL).all();
  return rows.length;
}

export interface IngestAgentsResult {
  readonly rowCount: number;
  readonly ingestMs: number;
  readonly cteRowCount: number;
}

export function ingestFlatAgentRowsToSqlite(
  rows: readonly FlatAgentRow[],
  dbPath: string,
): IngestAgentsResult {
  const db = openSportsdeskSqlite(dbPath);
  try {
    const { rowCount, ingestMs } = ingestFlatAgentsWithTiming(db, rows);
    const cteRowCount = countAgentTreeCteRows(db);
    return { rowCount, ingestMs, cteRowCount };
  } finally {
    db.close();
  }
}

export function ingestNormalizedTreeToSqlite(
  tree: unknown,
  dbPath: string,
): IngestAgentsResult {
  const flat = flattenNormalizedHierarchyTree(tree);
  return ingestFlatAgentRowsToSqlite(flat, dbPath);
}

export function ingestGeneralToSqlite(
  general: readonly PortalGeneralRow[],
  ctx: PortalHierarchyParserContext,
  dbPath: string,
): IngestAgentsResult {
  const flat = flatAgentsFromPortalParse(general, ctx);
  return ingestFlatAgentRowsToSqlite(flat, dbPath);
}
