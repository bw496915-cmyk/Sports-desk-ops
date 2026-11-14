import { describe, expect, test } from "bun:test";
import {
  buildFigureDateWagersRequest,
  FIGURE_DATE_WAGERS_PATH,
} from "../lib/f402_figure_date_enricher.ts";

describe("buildFigureDateWagersRequest", () => {
  test("reproduces the observed 2026-11-13 request", () => {
    expect(
      buildFigureDateWagersRequest({
        agentID: "BILLY666",
        customerID: "BRT106",
        date: "2026-11-13",
        figureDate: "2026-11-12",
      }),
    ).toEqual({
      agentID: "BILLY666",
      agentOwner: "BILLY666",
      customerID: "BRT106",
      date: "2026-11-13",
      figureDate: "2026-11-12",
      graded: 0,
      path: FIGURE_DATE_WAGERS_PATH,
      RRO: 1,
      sort: 1,
      typeSort: 2,
      week: 0,
    });
  });

  test("keeps agentOwner and the sort pair overridable", () => {
    const body = buildFigureDateWagersRequest({
      agentID: "BILLY666",
      agentOwner: "MASTER_A",
      customerID: "BRT106",
      date: "2026-11-13",
      figureDate: "2026-11-12",
      graded: 1,
      sort: 0,
      typeSort: 1,
      week: 2,
    });
    expect(body.agentOwner).toBe("MASTER_A");
    expect(body.graded).toBe(1);
    expect(body.sort).toBe(0);
    expect(body.typeSort).toBe(1);
    expect(body.week).toBe(2);
    expect(body.RRO).toBe(1);
  });

  test("rejects a day that is not YYYY-MM-DD", () => {
    expect(() =>
      buildFigureDateWagersRequest({
        agentID: "BILLY666",
        customerID: "BRT106",
        date: "11/13/2026",
        figureDate: "2026-11-12",
      }),
    ).toThrow(/date must be YYYY-MM-DD/);
  });
});
