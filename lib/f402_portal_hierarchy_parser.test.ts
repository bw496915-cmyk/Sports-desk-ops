import { describe, expect, test } from "bun:test";

import {
  normalizeNested,
  oracleSnapshot,
  runPortalHierarchyOracle,
  type PortalGeneralRow,
} from "./f402_portal_hierarchy_oracle.ts";
import {
  runBaseHeriarchyParser,
  type PortalHierarchyParserContext,
} from "./f402_portal_hierarchy_parser.ts";
import { firstOracleSnapshotLineDiff } from "./f402_portal_hierarchy_parser_diff.ts";
import { parseProductionOracleFixtureText } from "./f402_production_fixture_redaction.ts";
import { join } from "node:path";

const CTX: PortalHierarchyParserContext = {
  masterId: "MASTER1",
  masterLogin: "MASTER1",
};

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

describe("runBaseHeriarchyParser vs oracle", () => {
  test("Levels 1–12 chain empty diff", async () => {
    const general: PortalGeneralRow[] = [row(1, "ROOT", "M")];
    for (let level = 2; level <= 12; level++) {
      general.push(row(level, `NODE${level}`, level === 12 ? "A" : "M"));
    }
    const oracle = await runPortalHierarchyOracle(general, { runSetComplete: false });
    const parsed = runBaseHeriarchyParser(general, CTX);
    expect(oracleSnapshot(normalizeNested(parsed))).toBe(
      oracleSnapshot(oracle.nested),
    );
  });

  test("production fixture matches pinned nestedSnapshotSha256", async () => {
    const fixturePath = join(
      import.meta.dir,
      "../tests/fixtures/f402-general-oracle-production.json",
    );
    const manifest = (await Bun.file(
      join(import.meta.dir, "../verification/manager-boot-oracle/pinned/manifest.json"),
    ).json()) as { productionOracleGate?: { nestedSnapshotSha256?: string } };
    const pinned = manifest.productionOracleGate?.nestedSnapshotSha256;
    expect(pinned).toBeString();

    const text = await Bun.file(fixturePath).text();
    const fixture = parseProductionOracleFixtureText(text);
    const general = fixture.GENERAL as PortalGeneralRow[];
    const parsed = runBaseHeriarchyParser(general, CTX);
    const parsedSnap = oracleSnapshot(normalizeNested(parsed));
    const { sha256HexText } = await import("./f402_portal_version_pin.ts");
    const live = await sha256HexText(parsedSnap);
    if (live !== pinned) {
      const oracle = await runPortalHierarchyOracle(general, {
        runSetComplete: false,
      });
      const oracleSnap = oracleSnapshot(oracle.nested);
      const detail = firstOracleSnapshotLineDiff(parsedSnap, oracleSnap);
      throw new Error(
        `parser nestedSnapshotSha256 mismatch (parser behavior changed)\n  pinned=${pinned}\n  live=${live}\n  ${detail}`,
      );
    }
  });
});
