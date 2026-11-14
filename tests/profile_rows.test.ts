import { describe, expect, test } from "bun:test";
import { bookRowsToProfiles } from "../packages/ui/src/profile_rows.ts";

const row = {
  customer_id: "SYNTH_SYN_01",
  agent_id: "SYNTH_AGENT_01",
  master_agent: "SYNTH_MASTER_01",
  context_type: "STEAM_CHASER",
  wager_limit_usd: 15000,
  delay_seconds: 0,
  ip_subnet: "203.0.113.0/24",
  lifetime_net_usd: -75000,
  hold_pct: -15,
  clv_bps: 40,
  sharp_score: 81.5,
  recent_tickets: [
    { league: "CFB", market: "SPREAD", risk_usd: 4000 },
    { league: "CFB", market: "SPREAD", risk_usd: 4000 },
    { league: "NFL", market: "TOTAL", risk_usd: 2000 },
  ],
};

describe("bookRowsToProfiles", () => {
  const [profile] = bookRowsToProfiles([row]);

  test("uses the book identity, not the sample id", () => {
    expect(profile?.id).toBe("SYNTH_SYN_01");
    expect(profile?.agentId).toBe("SYNTH_AGENT_01");
    expect(profile?.masterAgent).toBe("SYNTH_MASTER_01");
  });

  test("derives the score, CLV and tier from the book", () => {
    expect(profile?.score).toBeCloseTo(8.15, 5);
    expect(profile?.clvScore).toBeCloseTo(0.4, 5);
    expect(profile?.tier).toBe("TIER_2_STEAM_SYNDICATE");
    expect(profile?.action).toBe("ALERT_OPERATOR");
  });

  test("derives sizing from the ticket spread", () => {
    expect(profile?.meanStake).toBeCloseTo(3333.333, 2);
    expect(profile?.sizingStrategy).toBe("PROPORTIONAL_KELLY");
    expect(profile?.gini).toBeGreaterThan(0);
  });

  test("specialization comes from the most common league and market", () => {
    expect(profile?.specialization).toBe("CFB SPREAD");
  });

  test("carries the book's limits and net", () => {
    expect(profile?.recommendedLimitUsd).toBe(15000);
    expect(profile?.ltvUsd).toBe(-75000);
    expect(profile?.holdPct).toBe(-15);
  });

  test("marks fields the book does not carry as none, not a guess", () => {
    expect(profile?.syndicateRisk).toBe("LOW");
    expect(profile?.syndicateProb).toBe(0);
    expect(profile?.correlatedRisk).toBe("NONE");
    expect(profile?.lineShadeCents).toBe(0);
  });
});
