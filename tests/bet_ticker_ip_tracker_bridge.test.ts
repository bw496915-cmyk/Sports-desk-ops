import { describe, expect, test } from "bun:test";
import {
  formatWebLogDateForMode,
  buildPerOfficeIpMatcherPayload,
  buildPlayerIpMatcherPayload,
  normalizeWebLogLoginId,
  lookupIpTrackerMatchForBetTicker,
  PER_OFFICE_IP_TRACKER_CLUSTERS,
} from "../lib/bet_ticker_ip_tracker_bridge.ts";

describe("bet_ticker_ip_tracker_bridge (ip-tracker.js & bet-ticker.js)", () => {
  test("Mode B Per-Office IP Matcher passes officeAgentId in customerID and MM/DD/YYYY dates", () => {
    const perOffice = buildPerOfficeIpMatcherPayload({
      masterAgentId: "BILLY666",
      officeAgentId: "MJ2026",
      startDateMdy: "10/31/2026",
      endDateMdy: "10/31/2026",
    });
    expect(perOffice.type).toBe("B");
    expect(perOffice.agentID).toBe("BILLY666");
    expect(perOffice.customerID).toBe("MJ2026");
    expect(perOffice.start).toBe("10/31/2026");
    expect(perOffice.operation).toBe("getWebLog");

    const globalMaster = buildPerOfficeIpMatcherPayload({
      masterAgentId: "BILLY666",
      officeAgentId: null,
    });
    expect(globalMaster.customerID).toBe("0");
  });

  test("Mode C Player IP Matcher converts MM/DD/YYYY to YYYY-MM-DD per ip-tracker.js line 77", () => {
    expect(formatWebLogDateForMode("10/31/2026", "C")).toBe("2026-10-31");
    expect(formatWebLogDateForMode("2026-10-31", "B")).toBe("10/31/2026");

    const modeC = buildPlayerIpMatcherPayload({
      masterAgentId: "BILLY666",
      customerLogin: "CB112_1",
      startDate: "10/28/2026",
      endDate: "10/31/2026",
    });
    expect(modeC.type).toBe("C");
    expect(modeC.customerID).toBe("CB112_1");
    expect(modeC.start).toBe("2026-10-28");
    expect(modeC.end).toBe("2026-10-31");
  });

  test("normalizes LoginID strings and resolves Per-Office & Cross-Office IP matches for Bet-Ticker rows", () => {
    expect(normalizeWebLogLoginId(" .mj102. ")).toBe("MJ102");
    expect(PER_OFFICE_IP_TRACKER_CLUSTERS.length).toBe(13);

    const mjMatch = lookupIpTrackerMatchForBetTicker("EJ8834");
    expect(mjMatch).toBeDefined();
    expect(mjMatch?.officeAgentId).toBe("MJ2026");
    expect(mjMatch?.matchClassification).toBe("PER_OFFICE_IP_MATCH");
    expect(mjMatch?.matchedLoginsInOffice).toContain("MJ102");
    expect(mjMatch?.matchedLoginsInOffice).toContain("MJ103");
    expect(mjMatch?.mfcsCompositeScore).toBe(98);

    const cubMatch = lookupIpTrackerMatchForBetTicker("CB112_2");
    expect(cubMatch?.matchClassification).toBe("BOTH_PER_OFFICE_AND_CROSS_OFFICE");
    expect(cubMatch?.crossOfficeLogins.some((x) => x.officeAgentId === "MAX92")).toBe(true);
  });
});
