import { describe, expect, test } from "bun:test";

import {
  oracleSnapshot,
  runPortalHierarchyOracle,
  type PortalGeneralRow,
} from "./f402_portal_hierarchy_oracle.ts";

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

/** Portal `baseHeriarchy` expects pre-order walk: L1, then L2 under current L1, … */
function chainLevels1Through12(): PortalGeneralRow[] {
  const out: PortalGeneralRow[] = [row(1, "ROOT", "M")];
  for (let level = 2; level <= 12; level++) {
    out.push(row(level, `NODE${level}`, level === 12 ? "A" : "M"));
  }
  return out;
}

describe("portal hierarchy oracle (pinned manager.js extraction)", () => {
  test("runs baseHeriarchy + setCompleteHeriarchy on Levels 1–12 chain", async () => {
    const general = chainLevels1Through12();
    const result = await runPortalHierarchyOracle(general, {
      runSetComplete: true,
    });
    expect(result.completeHeriarchyLength).toBe(12);
    expect(result.nested).toBeTruthy();
    expect(result.completeHeriarchy).toBeTruthy();
    const snap = oracleSnapshot(result.nested);
    expect(snap).toContain("ROOT");
    expect(snap).toContain("NODE12");
    expect(JSON.stringify(result.completeHeriarchy)).toContain("ROOT");
  });

  test("duplicate AgentID at Level 1: last row wins in nested map", async () => {
    const general: PortalGeneralRow[] = [
      row(1, "DUP", "M"),
      {
        ...row(1, "DUP", "A"),
        Login: "DUP_SECOND",
        AgentType: "A",
      },
    ];
    const result = await runPortalHierarchyOracle(general);
    const snap = oracleSnapshot(result.nested);
    expect(snap).toContain("DUP_SECOND");
  });

  describe("pinned bundle compat (match manifest manager.js; update with slice guard on bust drift)", () => {
    test("Level 13: drop silently — no branch in baseHeriarchy", async () => {
      const general = [...chainLevels1Through12(), row(13, "L13", "A")];
      const result = await runPortalHierarchyOracle(general);
      expect(result.completeHeriarchyLength).toBe(13);
      const snap = oracleSnapshot(result.nested);
      expect(snap).not.toContain("L13");
    });

    test("L2 orphan before L1: nest under empty parent key (p[t] not p[t][a])", async () => {
      const result = await runPortalHierarchyOracle([row(2, "ORPHAN", "A")]);
      const snap = oracleSnapshot(result.nested);
      expect(snap).toContain("ORPHAN");
      expect(snap).toContain('""');
    });
  });
});
