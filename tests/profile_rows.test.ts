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

  test("sharp_score is a 0-100 value divided by ten", () => {
    // Assert the unit so a row that is already 0-10 cannot silently be divided twice.
    expect(bookRowsToProfiles([row])[0]?.score).toBe(8.15);
  });

  test("empty tickets mark sizing, Gini, VaR and specialization unknown", () => {
    const [empty] = bookRowsToProfiles([{ ...row, recent_tickets: [] }]);
    expect(empty?.meanStake).toBe(0);
    expect(empty?.unknown).toContain("sizing");
    expect(empty?.unknown).toContain("gini");
    expect(empty?.unknown).toContain("var95");
    expect(empty?.specialization).toBe("STEAM_CHASER");
  });

  test("a missing sharp_score does not produce NaN", () => {
    const bare = { ...row, sharp_score: undefined, recent_tickets: [] };
    const [profile] = bookRowsToProfiles([bare]);
    expect(Number.isNaN(profile?.score)).toBe(false);
    expect(profile?.score).toBe(0);
    expect(profile?.unknown).toContain("sharpness");
  });

  test("a measured zero score is not marked unknown", () => {
    const [zero] = bookRowsToProfiles([{ ...row, sharp_score: 0 }]);
    expect(zero?.score).toBe(0);
    expect(zero?.unknown).not.toContain("sharpness");
  });

  test("a single ticket is its own most common league and market", () => {
    const [single] = bookRowsToProfiles([
      {
        ...row,
        recent_tickets: [{ league: "NBA", market: "TOTAL", risk_usd: 100 }],
      },
    ]);
    expect(single?.specialization).toBe("NBA TOTAL");
    expect(single?.unknown).toContain("gini");
    expect(single?.unknown).toContain("var95");
    expect(single?.unknown).toContain("sizing");
  });

  test("a tie keeps the first-seen league", () => {
    const [tie] = bookRowsToProfiles([
      {
        ...row,
        recent_tickets: [
          { league: "CFB", market: "SPREAD", risk_usd: 100 },
          { league: "NFL", market: "TOTAL", risk_usd: 100 },
        ],
      },
    ]);
    expect(tie?.specialization).toBe("CFB SPREAD");
  });

  test("marks fields the book does not carry as none, not a guess", () => {
    expect(profile?.syndicateRisk).toBe("LOW");
    expect(profile?.syndicateProb).toBe(0);
    expect(profile?.correlatedRisk).toBe("NONE");
    expect(profile?.lineShadeCents).toBe(0);
  });
});
