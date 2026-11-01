import { describe, expect, test } from "bun:test";

import type { PortalGeneralRow } from "./f402_portal_hierarchy_oracle.ts";
import {
  ingestManagerHierarchy,
  listSkippedOverflowAgents,
  PORTAL_HIERARCHY_PARSER_MAX_LEVEL,
} from "./f402_manager_hierarchy_ingest.ts";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";

function row(
  level: number,
  agentId: string,
  agentType: "A" | "M" = "M",
): PortalGeneralRow {
  return {
    AgentID: `${agentId} `,
    Login: agentId,
    Level: level,
    AgentType: agentType,
    SeqNumber: level + 1000,
  };
}

describe("f402_manager_hierarchy_ingest", () => {
  test("level 13+ skipped without throw; levels 1–12 stay connected", () => {
    const general: PortalGeneralRow[] = [row(1, "ROOT", "M")];
    for (let level = 2; level <= 12; level++) {
      general.push(row(level, `NODE${level}`, level === 12 ? "A" : "M"));
    }
    general.push(row(13, "OVERFLOW", "A"));

    const skipped = listSkippedOverflowAgents(general);
    expect(skipped).toEqual([{ agent_id: "OVERFLOW", level: 13 }]);

    const db = openSportsdeskSqlite(":memory:");
    const result = ingestManagerHierarchy(
      db,
      { GENERAL: general },
      { masterId: "MASTER1", masterLogin: "MASTER1" },
    );

    expect(result.generalRowCount).toBe(13);
    expect(result.skippedOverflow).toHaveLength(1);
    expect(result.rowCount).toBe(12);
    expect(result.cteRowCount).toBe(12);

    const overflow = db
      .query(`SELECT agent_id FROM agents WHERE agent_id = ?`)
      .get("OVERFLOW");
    expect(overflow).toBeNull();

    const leaf = db
      .query(`SELECT agent_id, parent_id, level FROM agents WHERE level = 12`)
      .get() as { agent_id: string; parent_id: string; level: bigint };
    expect(leaf.agent_id).toBe("NODE12");
    expect(leaf.parent_id).toBe("NODE11");

    const reachable = db
      .query(
        `WITH RECURSIVE t(agent_id) AS (
          SELECT agent_id FROM agents WHERE level = 1
          UNION ALL
          SELECT a.agent_id FROM agents a JOIN t ON a.parent_id = t.agent_id
        ) SELECT count(*) AS c FROM t`,
      )
      .get() as { c: bigint };
    expect(Number(reachable.c)).toBe(12);

    db.close();
  });

  test("PORTAL_HIERARCHY_PARSER_MAX_LEVEL documents parser port", () => {
    expect(PORTAL_HIERARCHY_PARSER_MAX_LEVEL).toBe(12);
  });
});
