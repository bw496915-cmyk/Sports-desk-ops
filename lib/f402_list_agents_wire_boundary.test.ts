import { describe, expect, test } from "bun:test";

import { parseListAgentsByAgentWireText } from "./f402_list_agents_wire_boundary.ts";

describe("parseListAgentsByAgentWireText", () => {
  test("parses strict envelope", () => {
    const env = parseListAgentsByAgentWireText(
      JSON.stringify({ GENERAL: [], PLAYERS: [], EXTRA: true }),
    );
    expect(env.GENERAL).toEqual([]);
    expect(env.PLAYERS).toEqual([]);
    expect(env.EXTRA).toBe(true);
  });

  test("rejects login HTML wrapper keys", () => {
    expect(() =>
      parseListAgentsByAgentWireText(
        JSON.stringify({ GENERAL: [], PLAYERS: [], EXTRA: true, error: 1 }),
      ),
    ).toThrow(/exactly \{GENERAL, PLAYERS, EXTRA\}/);
  });
});
