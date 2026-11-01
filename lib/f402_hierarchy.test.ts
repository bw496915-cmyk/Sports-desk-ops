import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  assertNoAgentLoginCollisions,
  detectAgentLoginCollisions,
  maxGeneralLevel,
} from "./f402_hierarchy_agents.ts";
import {
  applyPlayersModeToParsed,
  applyPlayersModeToJsonText,
} from "./f402_hierarchy_envelope.ts";
import { isDuplicateEnvelope, resetEnvelopeDedupe } from "./f402_hierarchy_dedupe.ts";
import { HierarchyEnvelopeView } from "./f402_hierarchy_envelope_view.ts";
import { envelopeTreeHash, stableStringify } from "./f402_hierarchy_hash.ts";
import { redactUnknown } from "./f402_hierarchy_redact.ts";
import { withTrace } from "./f402_hierarchy_trace.ts";
import { parseListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";

const fixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-list-agents-by-agent-snippet.json",
);

describe("f402 hierarchy bun-native", () => {
  test("PLAYERS_MODE off strips player rows", async () => {
    const raw = await Bun.file(fixture).json();
    const env = applyPlayersModeToParsed(raw, "off");
    expect(env.PLAYERS).toEqual([]);
    expect(env.GENERAL.length).toBeGreaterThan(0);
  });

  test("PLAYERS_MODE projected drops Password", async () => {
    const raw = await Bun.file(fixture).json();
    const env = applyPlayersModeToParsed(raw, "projected");
    expect(env.PLAYERS[0]).not.toHaveProperty("Password");
    expect(env.PLAYERS[0]).toHaveProperty("Login");
  });

  test("applyPlayersModeToJsonText round-trip", async () => {
    const text = await Bun.file(fixture).text();
    const slim = applyPlayersModeToJsonText(text, "off");
    const parsed = parseListAgentsByAgentEnvelope(JSON.parse(slim));
    expect(parsed.PLAYERS).toHaveLength(0);
  });

  test("agent login collision detection", () => {
    const collisions = detectAgentLoginCollisions([
      { AgentID: "A1 ", Login: "SAME ", SeqNumber: 1, Level: 1 },
      { AgentID: "A2 ", Login: "same", SeqNumber: 2, Level: 1 },
    ]);
    expect(collisions).toHaveLength(1);
    expect(() =>
      assertNoAgentLoginCollisions([
        { AgentID: "A1 ", Login: "SAME ", SeqNumber: 1, Level: 1 },
        { AgentID: "A2 ", Login: "same", SeqNumber: 2, Level: 1 },
      ]),
    ).toThrow(/collisions/);
  });

  test("stableStringify + envelopeTreeHash deterministic", async () => {
    const raw = await Bun.file(fixture).json();
    const env = applyPlayersModeToParsed(raw, "off");
    const a = await envelopeTreeHash(env);
    const b = await envelopeTreeHash(env);
    expect(a).toBe(b);
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}\n');
  });

  test("Bun.deepEquals dedupe detects identical envelope", async () => {
    resetEnvelopeDedupe();
    const raw = await Bun.file(fixture).json();
    const env = applyPlayersModeToParsed(raw, "off");
    expect(isDuplicateEnvelope(env)).toBe(false);
    expect(isDuplicateEnvelope(env)).toBe(true);
  });

  test("HierarchyEnvelopeView redacts Password in inspect", async () => {
    const raw = await Bun.file(fixture).json();
    const env = parseListAgentsByAgentEnvelope(raw);
    const text = new HierarchyEnvelopeView(env).toSafeString();
    expect(text).not.toContain("fixture-only");
    expect(text).toContain("[REDACTED]");
  });

  test("withTrace assigns monotonic id", async () => {
    let seen = "";
    await withTrace("test", async (t) => {
      seen = t.id;
      t.step("x");
    });
    expect(seen.length).toBeGreaterThan(10);
  });

  test("redactUnknown masks password keys", () => {
    const out = redactUnknown({ Password: "x", Login: "y" }) as Record<
      string,
      unknown
    >;
    expect(out.Password).toBe("[REDACTED]");
    expect(out.Login).toBe("y");
  });

  test("maxGeneralLevel from fixture", async () => {
    const raw = await Bun.file(fixture).json();
    const env = parseListAgentsByAgentEnvelope(raw);
    expect(maxGeneralLevel(env.GENERAL)).toBe(7);
  });
});
