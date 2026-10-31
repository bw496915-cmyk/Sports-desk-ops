import { describe, expect, test } from "bun:test";
import {
  parseLineHundredths,
  formatLineHundredths,
  computeComboIdentityHashes,
  mapPolyLeg,
  mapF402Leg,
  mapF402ReportLeg,
  extractF402RotationNumber,
  computeF402EffectiveLine,
  groupF402PendingRowsByTicket,
  F402_CUSTOMER_REPORT_ENDPOINTS,
  F402_WAGER_TYPE_MAP,
  type CanonicalLeg,
  type LineHundredths,
} from "../lib/combo_identity.ts";
import { createComboObservationsLegsStore } from "../lib/combo_observations_legs_store.ts";
import {
  LayoffRiskEngine,
  detectKeyNumberCrossing,
  evaluateBetterVenue,
} from "../lib/layoff_risk_engine.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

describe("combo_identity & Rosetta Stone (customer/report/report.js)", () => {
  test("LineHundredths normalizes floats and collapses IEEE-754 noise", () => {
    expect(parseLineHundredths(-3.25)).toBe(-325 as LineHundredths);
    expect(parseLineHundredths("+7.0")).toBe(700 as LineHundredths);
    expect(parseLineHundredths(3.5000000000000004)).toBe(350 as LineHundredths);
    expect(parseLineHundredths(48)).toBe(4800 as LineHundredths);
    expect(parseLineHundredths(null)).toBeNull();
  });

  test("LineHundredths rejects sub-hundredth precision", () => {
    expect(() => parseLineHundredths(3.245)).toThrow(RangeError);
    expect(() => parseLineHundredths(-6.125)).toThrow(RangeError);
  });

  test("Rosetta Stone: getRotationNumber selects Team1RotNum when Team1ID === ChosenTeamID else Team2RotNum and normalizes GameNum+5000", () => {
    const r1 = extractF402RotationNumber({
      Team1ID: "Baylor",
      Team2ID: "TCU",
      ChosenTeamID: "Baylor",
      Team1RotNum: 341,
      Team2RotNum: 342,
    });
    expect(r1.rawRotNum).toBe(341);
    expect(r1.canonicalRotNum).toBe(341);
    expect(r1.isAltSpreadRotation).toBe(false);

    const r2 = extractF402RotationNumber({
      Team1ID: "Lakers",
      Team2ID: "Celtics",
      ChosenTeamID: "Celtics",
      Team1RotNum: 5501,
      Team2RotNum: 5502,
    });
    expect(r2.rawRotNum).toBe(5502);
    expect(r2.canonicalRotNum).toBe(502);
    expect(r2.isAltSpreadRotation).toBe(true);
  });

  test("Rosetta Stone: getLineGame computes Effective Line for Spread and Total Teasers", () => {
    // Spread Teaser: AdjSpread -7.5 + TeaserPoints 6.0 -> Effective Line -1.5 (-150 hundredths)
    const spreadTeaser = computeF402EffectiveLine({
      WagerType: "T",
      AdjSpread: -7.5,
      TeaserPoints: 6.0,
    });
    expect(spreadTeaser.marketKind).toBe("spread");
    expect(spreadTeaser.rawLine).toBe(-7.5);
    expect(spreadTeaser.effectiveLine).toBe(-1.5);
    expect(spreadTeaser.effectiveLineHundredths).toBe(-150 as LineHundredths);

    // Total OVER Teaser: AdjTotalPoints 48.0 - TeaserPoints 6.0 -> Effective Line 42.0 (4200 hundredths)
    const overTeaser = computeF402EffectiveLine({
      WagerType: "L",
      AdjTotalPoints: 48.0,
      TotalPointsOU: "o",
      TeaserPoints: 6.0,
    });
    expect(overTeaser.marketKind).toBe("total");
    expect(overTeaser.side).toBe("OVER");
    expect(overTeaser.effectiveLine).toBe(42.0);
    expect(overTeaser.effectiveLineHundredths).toBe(4200 as LineHundredths);

    // Total UNDER Teaser: AdjTotalPoints 48.0 + TeaserPoints 6.0 -> Effective Line 54.0 (5400 hundredths)
    const underTeaser = computeF402EffectiveLine({
      WagerType: "L",
      AdjTotalPoints: 48.0,
      TotalPointsOU: "u",
      TeaserPoints: 6.0,
    });
    expect(underTeaser.marketKind).toBe("total");
    expect(underTeaser.side).toBe("UNDER");
    expect(underTeaser.effectiveLine).toBe(54.0);
    expect(underTeaser.effectiveLineHundredths).toBe(5400 as LineHundredths);
  });

  test("Rosetta Stone: groupF402PendingRowsByTicket groups legs by TicketNumber-WagerNumber before hashing and skips Casino (C)", () => {
    const grouped = groupF402PendingRowsByTicket([
      {
        TicketNumber: 894100,
        WagerNumber: 1,
        CustomerID: "CB112_1",
        AgentID: "CUB22HR",
        AmountWagered: 500000,
        ToWinAmount: 1300000,
        WagerType: "P",
        SportType: "CFB",
        GameDateTime: "2026-10-31 19:00:00",
        Team1ID: "BAYLOR",
        Team2ID: "TCU",
        ChosenTeamID: "BAYLOR",
        Team1RotNum: 341,
        Team2RotNum: 342,
        AdjSpread: 3.5,
      },
      {
        TicketNumber: 894100,
        WagerNumber: 1,
        CustomerID: "CB112_1",
        AgentID: "CUB22HR",
        AmountWagered: 500000,
        ToWinAmount: 1300000,
        WagerType: "L",
        SportType: "CFB",
        GameDateTime: "2026-10-31 19:00:00",
        Team1ID: "BAYLOR",
        Team2ID: "TCU",
        ChosenTeamID: "BAYLOR",
        Team1RotNum: 341,
        Team2RotNum: 342,
        AdjTotalPoints: 47.5,
        TotalPointsOU: "o",
      },
      {
        TicketNumber: 894101,
        WagerNumber: 1,
        CustomerID: "CB112_1",
        AgentID: "CUB22HR",
        AmountWagered: 10000,
        ToWinAmount: 10000,
        WagerType: "C", // Casino row - should be skipped!
      },
    ]);

    expect(grouped.length).toBe(1);
    expect(grouped[0]!.ticketGroupKey).toBe("894100-1");
    expect(grouped[0]!.legs.length).toBe(2);
    expect(grouped[0]!.legs[0]!.rotationNumber).toBe(341);
    expect(grouped[0]!.legs[1]!.marketKind).toBe("total");
    expect(grouped[0]!.legs[1]!.side).toBe("OVER");
    expect(grouped[0]!.legs[1]!.lineHundredths).toBe(4750 as LineHundredths);
    expect(F402_CUSTOMER_REPORT_ENDPOINTS.gradingByFigureDate).toBe("api/Report/getGrading");
    expect(F402_WAGER_TYPE_MAP.E.name).toBe("Team Total");
  });

  test("pure identity hashing is order-independent", () => {
    const legA: CanonicalLeg = {
      gameId: "CFB:BAYLOR_VS_TEXAS_TECH",
      subject: "BAYLOR",
      marketKind: "total",
      side: "OVER",
      lineHundredths: 4800 as LineHundredths,
      productClass: "parlay",
    };
    const legB: CanonicalLeg = {
      gameId: "NFL:NE_VS_NYJ",
      subject: "NE",
      marketKind: "spread",
      side: "FAVORITE",
      lineHundredths: -700 as LineHundredths,
      productClass: "parlay",
    };

    const hash1 = computeComboIdentityHashes([legA, legB]);
    const hash2 = computeComboIdentityHashes([legB, legA]);

    expect(hash1.identitySha256).toBe(hash2.identitySha256);
    expect(hash1.shapeSha256).toBe(hash2.shapeSha256);
    expect(hash1.pickShapeSha256).toBe(hash2.pickShapeSha256);
  });

  test("shape_sha256 ignores line deltas while identity_sha256 differentiates them", () => {
    const leg1: CanonicalLeg = {
      gameId: "NFL:NE_VS_NYJ",
      subject: "NE",
      marketKind: "spread",
      side: "FAVORITE",
      lineHundredths: -650 as LineHundredths,
      productClass: "parlay",
    };
    const leg2: CanonicalLeg = {
      gameId: "NFL:NE_VS_NYJ",
      subject: "NE",
      marketKind: "spread",
      side: "FAVORITE",
      lineHundredths: -750 as LineHundredths,
      productClass: "parlay",
    };

    const h1 = computeComboIdentityHashes([leg1]);
    const h2 = computeComboIdentityHashes([leg2]);

    expect(h1.shapeSha256).toBe(h2.shapeSha256);
    expect(h1.identitySha256).not.toBe(h2.identitySha256);
  });
});

describe("layoff_risk_engine", () => {
  test("key number detection catches 3, 7, 10, 14 boundaries", () => {
    expect(detectKeyNumberCrossing(-650, -750)).toBe(7);
    expect(detectKeyNumberCrossing(-250, -350)).toBe(3);
    expect(detectKeyNumberCrossing(-650, -650)).toBeNull();
  });

  test("better venue evaluation distinguishes favorite vs underdog vs totals", () => {
    expect(evaluateBetterVenue("spread", "FAVORITE", -650, -750)).toBe("polymarket");
    expect(evaluateBetterVenue("spread", "FAVORITE", -750, -650)).toBe("internal");

    expect(evaluateBetterVenue("total", "OVER", 4750, 4800)).toBe("polymarket");
    expect(evaluateBetterVenue("total", "OVER", 4800, 4750)).toBe("internal");
  });

  test("full end-to-end ingestion and layoff risk alert detection", () => {
    const db = openSportsdeskSqlite(":memory:");
    const store = createComboObservationsLegsStore(db);
    const engine = new LayoffRiskEngine(db);

    store.insertAttribution({
      proxyWallet: "0x3af8392189d021cfa82",
      customerId: "CB112_1",
      agentOwner: "CUB22HR",
    });

    store.ingestPolymarketCombo("0xpm_order_1", "0x3af8392189d021cfa82", [
      {
        competitionFamily: "NFL",
        team: "PATRIOTS",
        marketKind: "spread",
        side: "FAVORITE",
        line: -6.5,
        productClass: "parlay",
      },
    ]);

    store.ingestF402Ticket("9982", "1", "CB112_1", "CUB22HR", [
      {
        ticketNumber: "9982",
        wagerNumber: "1",
        customerId: "CB112_1",
        agentId: "CUB22HR",
        sportType: "NFL",
        ChosenTeamID: "PATRIOTS",
        Team1ID: "PATRIOTS",
        Team1RotNum: 451,
        Team2RotNum: 452,
        WagerType: "P",
        AdjSpread: -7.5,
      },
    ]);

    const matches = engine.queryLineDeltaMatches(100);
    expect(matches.length).toBe(1);

    const m = matches[0];
    expect(m.isLayoffRisk).toBe(true);
    expect(m.betterVenue).toBe("polymarket");
    expect(m.keyNumberCrossed).toBe(7);
    expect(m.deltaHundredths).toBe(100);

    const alerts = engine.formatLayoffRiskAlerts(matches);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("[ALERT] Layoff Risk");
    expect(alerts[0]).not.toContain("undefined");
    expect(alerts[0]).toContain("beats pending TKT-9982:1");
    expect(alerts[0]).toContain("[KEY 7]");
    expect(alerts[0]).toContain("CUB22HR/CB112_1");
  });
});
