import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentDownline, treeDownlineCounts } from "./agent_downline.ts";

describe("agent downline", () => {
  test("indexes agents by uppercase login and keeps missing fields null", async () => {
    const path = join(tmpdir(), `downline-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        meta: { master_agent: "M1" },
        agents: [
          { agent: "a1", master: "M1", total_accounts: 2, lifetime_net: -50 },
          { agent: "A2" },
          { agent: "" },
        ],
      }),
    );
    const index = await loadAgentDownline(path);
    expect(index?.agents).toBe(2);
    expect(index?.byAgent.get("A1")?.totalAccounts).toBe(2);
    expect(index?.byAgent.get("A1")?.grade).toBeNull();
    expect(index?.byAgent.get("A2")?.lifetimeNetUsd).toBeNull();
  });

  test("a missing file is null, not an empty index", async () => {
    expect(
      await loadAgentDownline("/tmp/does-not-exist-downline.json"),
    ).toBeNull();
  });

  test("counts direct and descendant agents from parent links", () => {
    const counts = treeDownlineCounts(
      {
        ROOT: {},
        A1: { p: "ROOT" },
        A2: { p: "ROOT" },
        B1: { p: "A1" },
        B2: { p: "A1" },
        C1: { p: "B1" },
      },
      ["root", "A1"],
    );
    expect(counts.get("ROOT")).toEqual({
      directAgents: 2,
      descendantAgents: 5,
    });
    expect(counts.get("A1")).toEqual({ directAgents: 2, descendantAgents: 3 });
  });
});
