import { describe, expect, test } from "bun:test";

import { assertListAgentsTopLevelKeys } from "./f402_list_agents_envelope_strict.ts";
import { parseListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";

describe("list-agents envelope strictness", () => {
  test("accepts EXTRA false (boolean, not object)", () => {
    const raw = { GENERAL: [], PLAYERS: [], EXTRA: false };
    assertListAgentsTopLevelKeys(raw);
    const env = parseListAgentsByAgentEnvelope(raw);
    expect(env.EXTRA).toBe(false);
  });

  test("accepts EXTRA true", () => {
    const raw = { GENERAL: [{ Level: 1 }], PLAYERS: [], EXTRA: true };
    assertListAgentsTopLevelKeys(raw);
    expect(parseListAgentsByAgentEnvelope(raw).EXTRA).toBe(true);
  });
});
