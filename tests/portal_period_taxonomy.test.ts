/**
 * @file tests/portal_period_taxonomy.test.ts
 * @description Invariant tests for the canonical Fantasy402 portal period taxonomy,
 * orphan period exclusion, engine detection, and multi-family date mapping.
 */

import { describe, expect, it } from "bun:test";
import {
  DATE_FAMILIES,
  PORTAL_PERIOD_LABELS,
  classifyPortalPeriod,
  detectEngine,
  extractRiskDollars,
  isDerivativePointsLineWager,
  normalizeWager,
} from "../lib/portal_period_taxonomy.ts";

describe("Portal Period Taxonomy Enum", () => {
  it("defines the canonical 0-6 enum matching the portal dropdown", () => {
    expect(PORTAL_PERIOD_LABELS[-1]).toBe("All Periods");
    expect(PORTAL_PERIOD_LABELS[0]).toBe("Game");
    expect(PORTAL_PERIOD_LABELS[1]).toBe("1st Half");
    expect(PORTAL_PERIOD_LABELS[2]).toBe("2nd Half");
    expect(PORTAL_PERIOD_LABELS[3]).toBe("1st Qtr");
    expect(PORTAL_PERIOD_LABELS[4]).toBe("2nd Qtr");
    expect(PORTAL_PERIOD_LABELS[5]).toBe("3rd Qtr");
    expect(PORTAL_PERIOD_LABELS[6]).toBe("4th Qtr");
  });
});

describe("Three Date-Field Families", () => {
  it("correctly maps aggregate modes (CP, CPS) to disabled start/end", () => {
    expect(DATE_FAMILIES.CP).toEqual({
      family: "Aggregate",
      startField: "start",
      endField: "end",
      defaultState: "disabled",
      hasPeriodFilter: false,
    });
    expect(DATE_FAMILIES.CPS).toEqual({
      family: "Aggregate",
      startField: "start",
      endField: "end",
      defaultState: "disabled",
      hasPeriodFilter: false,
    });
  });

  it("correctly maps customer volume (CPV) to startReportVolumen/endReportVolumen with period filter", () => {
    expect(DATE_FAMILIES.CPV).toEqual({
      family: "Customer Volume",
      startField: "startReportVolumen",
      endField: "endReportVolumen",
      defaultState: "disabled",
      hasPeriodFilter: true,
    });
  });

  it("correctly maps grading (G) to user-driven startG/endG", () => {
    expect(DATE_FAMILIES.G).toEqual({
      family: "Grading",
      startField: "startG",
      endField: "endG",
      defaultState: "enabled",
      hasPeriodFilter: false,
    });
  });
});

describe("Portal Period Classification & Orphan Periods", () => {
  it("folds incl_ot silently into 0 Game", () => {
    const res = classifyPortalPeriod({
      WagerType: "E",
      Period: "incl_ot",
      ShortDesc: "E.Football #101 Patriots - For Game",
    });
    expect(res.portalPeriod).toBe(0);
    expect(res.portalLabel).toBe("Game");
    expect(res.half).toBe("FG");
    expect(res.isOrphanOutOfPortal).toBe(false);
  });

  it("maps 1st Half and 1h to 1", () => {
    const resNative = classifyPortalPeriod({
      WagerType: "E",
      ShortDesc: "E.Basketball #501 Lakers O 55 - For 1st Half",
    });
    expect(resNative.portalPeriod).toBe(1);
    expect(resNative.portalLabel).toBe("1st Half");
    expect(resNative.half).toBe("1H");

    const resGansrow = classifyPortalPeriod({
      WagerType: "M",
      ShortDesc: "Soccer - France vs Italy / 1st Half / Total / Over 1.5",
      TicketWriter: "GSLIVE",
    });
    expect(resGansrow.portalPeriod).toBe(1);
    expect(resGansrow.half).toBe("1H");
  });

  it("maps 2nd Half and 2h to 2", () => {
    const res = classifyPortalPeriod({
      WagerType: "E",
      ShortDesc: "E.Basketball #501 Lakers O 55 - For 2nd Half",
    });
    expect(res.portalPeriod).toBe(2);
    expect(res.portalLabel).toBe("2nd Half");
    expect(res.half).toBe("2H");
  });

  it("maps quarters 1Q-4Q to 3-6", () => {
    expect(
      classifyPortalPeriod({
        WagerType: "E",
        ShortDesc: "Lakers - For 1st Quarter",
      }).portalPeriod,
    ).toBe(3);
    expect(
      classifyPortalPeriod({
        WagerType: "E",
        ShortDesc: "Lakers - For 2nd Quarter",
      }).portalPeriod,
    ).toBe(4);
    expect(
      classifyPortalPeriod({
        WagerType: "E",
        ShortDesc: "Lakers - For 3rd Quarter",
      }).portalPeriod,
    ).toBe(5);
    expect(
      classifyPortalPeriod({
        WagerType: "E",
        ShortDesc: "Lakers - For 4th Quarter",
      }).portalPeriod,
    ).toBe(6);
  });

  it("treats sets (set1, set2, set3) as null out-of-portal scope", () => {
    const set1 = classifyPortalPeriod({
      WagerType: "E",
      Period: "set1",
      ShortDesc: "Tennis - Player A - For Set 1",
    });
    expect(set1.portalPeriod).toBeNull();
    expect(set1.isOrphanOutOfPortal).toBe(true);
    expect(set1.half).toBe("OUT_OF_PORTAL");

    const set2 = classifyPortalPeriod({
      WagerType: "M",
      ShortDesc: "Tennis - Player A vs Player B / Set 2 / Over 4.5",
      TicketWriter: "GSLIVE",
    });
    expect(set2.portalPeriod).toBeNull();
    expect(set2.isOrphanOutOfPortal).toBe(true);
  });

  it("assumes empty period defaults to 0 Game", () => {
    const res = classifyPortalPeriod({
      WagerType: "E",
      ShortDesc: "E.Football #101 Patriots - For Game",
      Period: "",
    });
    expect(res.portalPeriod).toBe(0);
    expect(res.portalLabel).toBe("Game");
    expect(res.half).toBe("FG");
  });
});

describe("Engine Detection & Risk Dollars", () => {
  it("detects Native ASI desk from WagerType E", () => {
    expect(detectEngine({ WagerType: "E" })).toBe("native");
  });

  it("detects Gansrow feed from TicketWriter or Gansrow pattern", () => {
    expect(detectEngine({ WagerType: "M", TicketWriter: "GSLIVE" })).toBe(
      "gansrow",
    );
    expect(
      detectEngine({
        WagerType: "P",
        ShortDesc: "Belgium Over 1.5",
      }),
    ).toBe("gansrow");
  });

  it("identifies Derivative Points Lines across both ingestion feeds", () => {
    expect(isDerivativePointsLineWager({ WagerType: "E" })).toBe(true);
    expect(
      isDerivativePointsLineWager({
        WagerType: "M",
        ShortDesc: "France derivative points Over 1.5",
      }),
    ).toBe(true);
    expect(
      isDerivativePointsLineWager({
        WagerType: "S",
        ShortDesc: "Patriots -3.5",
      }),
    ).toBe(false);
  });

  it("normalizes cents to dollars when AmountWagered is provided", () => {
    expect(extractRiskDollars({ AmountWagered: 2300 })).toBe(23.0);
    expect(extractRiskDollars({ Risk: 23.5 })).toBe(23.5);
  });

  it("normalizes a full wager row", () => {
    const norm = normalizeWager({
      WagerNumber: 991001,
      WagerType: "E",
      ShortDesc: "E.Football #101 Patriots O 24½ -110 - For 1st Half",
      AmountWagered: 5000,
      Login: "VIP101",
      AgentLogin: "BOSS1",
      InsertDateTime: "2026-11-01 12:00:00.000",
      TicketWriter: "Internet",
    });

    expect(norm).toEqual({
      wagerNumber: 991001,
      engine: "native",
      wagerType: "E",
      portalPeriod: 1,
      half: "1H",
      market: "Native Desk Derivative Points Line (1st Half)",
      customer: "VIP101",
      agent: "BOSS1",
      sport: "Football",
      subSport: "CFB",
      risk: 50.0,
      ticketWriter: "Internet",
      insertedAt: "2026-11-01 12:00:00.000",
    });
  });
});
