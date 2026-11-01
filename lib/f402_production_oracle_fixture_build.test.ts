import { describe, expect, test } from "bun:test";

import { LIST_AGENTS_OPERATION } from "./f402_hierarchy_list_agents_operation.ts";
import { PRODUCTION_PASSWORD_SENTINEL } from "./f402_production_fixture_redaction.ts";
import { prepareProductionOracleFixtureTextFromHar } from "./f402_production_oracle_fixture_build.ts";

function qualifyingHar(body: unknown) {
  return {
    log: {
      entries: [
        {
          request: {
            method: "POST",
            url: "https://www.fantasy402.com/cloud/api/Manager/getListAgenstByAgent",
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              text: `operation=${LIST_AGENTS_OPERATION}&RRO=1`,
            },
          },
          response: {
            status: 200,
            content: { text: JSON.stringify(body) },
          },
        },
      ],
    },
  };
}

describe("prepareProductionOracleFixtureTextFromHar", () => {
  test("round-trip: redaction + label-agnostic oracle equivalence", async () => {
    const har = qualifyingHar({
      GENERAL: [
        {
          AgentID: "LIVEUSER    ",
          Login: "LIVEUSER    ",
          Level: 1,
          AgentType: "M",
          SeqNumber: 1,
        },
      ],
      PLAYERS: [
        {
          Login: "p",
          Password: PRODUCTION_PASSWORD_SENTINEL,
        },
      ],
      EXTRA: true,
    });
    const text = await prepareProductionOracleFixtureTextFromHar(har, "operator");
    const doc = JSON.parse(text) as {
      GENERAL: { Login: string; AgentID: string }[];
      PLAYERS: unknown[];
      _f402Redaction: { specVersion: number };
    };
    expect(doc.PLAYERS).toEqual([]);
    expect(doc.GENERAL[0]?.Login).toBe("AGENT_L1_N0    ");
    expect(doc.GENERAL[0]?.AgentID.length).toBe("AGENT_L1_N0".length + 4);
    expect(doc._f402Redaction.specVersion).toBe(1);
  });
});
