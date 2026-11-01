import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  describeListAgentsByAgentProbeResponse,
  F402_GENERAL_SEQ_BASE_AT_INDEX_ZERO,
  F402_PLAYERS_TYPICAL_COUNT,
  generalSeqNumbersMatchBasePlusIndex,
  normalizeAgentTreeGeneralRow,
  normalizeAgentTreeGeneralRows,
  normalizeAgentTreePlayerRow,
  normalizeAgentTreePlayerRows,
  parseListAgentsByAgentEnvelope,
  parsePlayerCustomerIdShape,
  redactListAgentsByAgentEnvelope,
  summarizeListAgentsByAgent,
  summarizeListAgentsByAgentPlayers,
} from "./f402_list_agents_by_agent.ts";

const fixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-list-agents-by-agent-snippet.json",
);
const tailFixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-list-agents-by-agent-general-tail.json",
);
const playersFixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-list-agents-players-snippet.json",
);

describe("getListAgenstByAgent GENERAL rows", () => {
  test("parse envelope and normalize seqNumber, level, agentType", () => {
    const env = parseListAgentsByAgentEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    expect(env.GENERAL).toHaveLength(4);
    expect(env.PLAYERS).toHaveLength(1);
    expect(env.EXTRA).toBe(false);

    const rows = normalizeAgentTreeGeneralRows(env.GENERAL);
    expect(rows[0]).toEqual({
      seqNumber: 5183,
      level: 1,
      agentType: "A",
      agentId: "BILLY667",
      login: "BILLY667",
      rates: {
        amigoTechRate: 0,
        betBuilderRate: 0,
        casinoHeadCountRateM: 0,
        crashRate: 0,
        extPropsRate: 0,
        fantasyRate: 0,
        flashBetsRate: 0,
        gitCasinoRate: 0,
        headCountRateM: 1,
        inetHeadCountRateM: 0,
        liveBetting2RateM: 0,
        liveBettingRateM: 0,
        liveCasinoRateM: 0,
        propBuilderRateM: 0,
      },
    });
    expect(rows[2]?.agentType).toBe("M");
    expect(rows[3]?.level).toBe(7);
  });

  test("normalizeAgentTreeGeneralRow rejects missing seq/level", () => {
    expect(
      normalizeAgentTreeGeneralRow({ AgentID: "X", AgentType: "A" }),
    ).toBeNull();
  });

  test("summarize counts agent types and seq continuity in array order", () => {
    const env = parseListAgentsByAgentEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    const summary = summarizeListAgentsByAgent(env);
    expect(summary.generalCount).toBe(4);
    expect(summary.playerCount).toBe(1);
    expect(summary.agentTypeCounts.A).toBe(2);
    expect(summary.agentTypeCounts.M).toBe(2);
    expect(summary.seqNumberMin).toBe(5183);
    expect(summary.seqNumberMax).toBe(5250);
    expect(summary.seqNumberStrictlyConsecutive).toBe(false);
    expect(summary.seqNumberEqualsBasePlusIndex).toBe(false);
    expect(summary.duplicateSeqNumbers).toEqual([]);
  });

  test("GENERAL tail 2460–2465: seq, levels, multi-space padding", () => {
    const env = parseListAgentsByAgentEnvelope(
      JSON.parse(readFileSync(tailFixture, "utf8")),
    );
    const globalStart = 2460;
    expect(
      generalSeqNumbersMatchBasePlusIndex(
        env.GENERAL,
        F402_GENERAL_SEQ_BASE_AT_INDEX_ZERO + globalStart,
      ).ok,
    ).toBe(true);

    const rows = normalizeAgentTreeGeneralRows(env.GENERAL);
    expect(rows[0]).toMatchObject({
      seqNumber: 7643,
      level: 6,
      agentType: "A",
      agentId: "FAKEMONEY",
      login: "FAKEMONEY",
    });
    expect(rows[2]).toMatchObject({
      seqNumber: 7645,
      level: 6,
      agentType: "M",
      agentId: "VIPALERTS",
      login: "VIPALERTS",
    });
    expect(rows[3]).toMatchObject({
      seqNumber: 7646,
      level: 7,
      agentType: "M",
      agentId: "JRREF",
      login: "JRREF",
    });
    expect(rows[4]).toMatchObject({
      seqNumber: 7647,
      level: 1,
      agentType: "A",
      agentId: "RTEST5",
      login: "RTEST5",
    });
    expect(rows[5]).toMatchObject({
      seqNumber: 7648,
      level: 1,
      agentType: "M",
      agentId: "SAINTS2009",
    });

    const summary = summarizeListAgentsByAgent(env);
    expect(summary.generalCount).toBe(6);
    expect(summary.seqNumberMax).toBe(7648);
    expect(summary.seqNumberEqualsBasePlusIndex).toBe(true);
    expect(summary.levelMin).toBe(1);
    expect(summary.levelMax).toBe(7);
    expect(summary.agentTypeCounts.M).toBe(3);
  });

  test("redactListAgentsByAgentEnvelope strips player Password", () => {
    const env = parseListAgentsByAgentEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    const redacted = redactListAgentsByAgentEnvelope(env);
    expect(redacted.PLAYERS[0]?.Password).toBe("<redacted>");
  });
});

describe("getListAgenstByAgent PLAYERS", () => {
  test("normalize padded customerID, login, agent; omit password", () => {
    const rows = normalizeAgentTreePlayerRows(
      JSON.parse(readFileSync(playersFixture, "utf8")),
    );
    expect(rows[0]).toEqual({
      customerId: "1_0",
      login: "1",
      nameFirst: "Dummy",
      agent: "JKN",
    });
    expect(rows[1]?.login).toBe("1001");
    expect(rows[1]?.nameFirst).toBe("OILEG");
    expect(parsePlayerCustomerIdShape(rows[1]!.customerId).hasEllipsis).toBe(
      true,
    );
    expect(rows[3]?.customerId).toBe("10502_1");
    expect(parsePlayerCustomerIdShape(rows[3]!.customerId).suffix).toBe("1");
    expect(rows[5]?.login).toBe("ZZWAN7");
    expect(normalizeAgentTreePlayerRow({})).toBeNull();
  });

  test("summarize players: dummy row, suffix/ellipsis counts, blank passwords", () => {
    const wire = JSON.parse(readFileSync(playersFixture, "utf8"));
    const summary = summarizeListAgentsByAgentPlayers(wire);
    expect(summary.playerCount).toBe(6);
    expect(summary.hasPortalDummyRow).toBe(true);
    expect(summary.distinctAgents).toBe(4);
    expect(summary.emptyNameFirstCount).toBe(3);
    expect(summary.blankPasswordCount).toBe(1);
    expect(summary.customerIdWithSuffixCount).toBe(3);
    expect(summary.customerIdEllipsisCount).toBe(2);
    expect(F402_PLAYERS_TYPICAL_COUNT).toBe(5763);
  });

  test("describeListAgentsByAgentProbeResponse returns summary line", () => {
    const env = parseListAgentsByAgentEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    const line = describeListAgentsByAgentProbeResponse(JSON.stringify(env));
    expect(line).toContain("GENERAL=4");
    expect(line).toContain("PLAYERS=1");
    expect(line).toContain("dummyRow=true");
  });
});
