import { describe, expect, test } from "bun:test";

import {
  assertProductionOracleFixtureRedaction,
  parseProductionOracleFixtureText,
  PRODUCTION_PASSWORD_SENTINEL,
  ProductionFixtureRedactionError,
} from "./f402_production_fixture_redaction.ts";

const valid = {
  _f402Redaction: { specVersion: 1, redactedByRole: "operator" },
  GENERAL: [
    {
      AgentID: "AGENT_L1_N0 ",
      Login: "AGENT_L1_N0",
      Level: 1,
      AgentType: "M",
    },
  ],
  PLAYERS: [],
  EXTRA: true,
};

describe("production oracle fixture redaction gate", () => {
  test("passes spec-compliant minimal fixture", () => {
    const text = JSON.stringify(valid);
    expect(() =>
      assertProductionOracleFixtureRedaction(text, valid),
    ).not.toThrow();
    const parsed = parseProductionOracleFixtureText(text);
    expect(parsed.GENERAL).toHaveLength(1);
    expect(parsed._f402Redaction.redactedByRole).toBe("operator");
  });

  test("fails on live-looking Login before oracle would run", () => {
    const bad = {
      ...valid,
      GENERAL: [
        {
          AgentID: "REALUSER ",
          Login: "REALUSER",
          Level: 1,
          AgentType: "M",
        },
      ],
    };
    const text = JSON.stringify(bad);
    expect(() => assertProductionOracleFixtureRedaction(text, bad)).toThrow(
      ProductionFixtureRedactionError,
    );
  });

  test("fails on non-empty PLAYERS", () => {
    const bad = {
      ...valid,
      PLAYERS: [
        {
          Login: "p1",
          Password: PRODUCTION_PASSWORD_SENTINEL,
        },
      ],
    };
    expect(() =>
      assertProductionOracleFixtureRedaction(JSON.stringify(bad), bad),
    ).toThrow(ProductionFixtureRedactionError);
  });

  test("fails on Bearer substring in file", () => {
    const text = `${JSON.stringify(valid)} Bearer eyJhbGciOiJIUzI1NiJ9`;
    expect(() =>
      assertProductionOracleFixtureRedaction(text, valid),
    ).toThrow(ProductionFixtureRedactionError);
  });
});
