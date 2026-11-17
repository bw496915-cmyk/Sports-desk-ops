import { describe, expect, test } from "bun:test";
import {
  projectAccountInfoOwner,
  projectWebReportsConfig,
} from "./agent_account.ts";

describe("account config projection", () => {
  test("drops the JWT, passwords, names and trims padding", () => {
    const projected = projectAccountInfoOwner({
      accountInfo: {
        customerID: "BILLY666  ",
        AgentID: "BILLY666                                          ",
        Office: "NOLAROSE",
        Store: "PPHINSIDER          ",
        AgentType: "M",
        TimeZone: 1,
        showPassword: "on",
        Password: "secret",
        PasswordFix: "‡",
        NameFirst: "Fake",
        NameLast: "Person",
        code: "fake.header.payload",
      },
      SERVER: { date: "2026-11-16 19:04:08.687" },
      preferenceDate: [{ BettingMode: "advance" }],
    });
    expect(projected.agentId).toBe("BILLY666");
    expect(projected.store).toBe("PPHINSIDER");
    expect(projected.office).toBe("NOLAROSE");
    expect(projected.displayFlags.showPassword).toBe("on");
    expect(projected.serverDate).toBe("2026-11-16 19:04:08.687");
    expect(JSON.stringify(projected)).not.toContain("fake.header.payload");
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("Fake");
  });

  test("refuses a response without accountInfo", () => {
    expect(() => projectAccountInfoOwner({ INFO: {} })).toThrow("accountInfo");
  });
});

describe("web-reports config projection", () => {
  test("trims AgentID and keeps only display flags plus weeklyScroll", () => {
    const projected = projectWebReportsConfig({
      INFO: {
        AgentID: "BILLY666                                          ",
        Config: "",
        showPassword: "on",
        showPending: "on",
        adds: { AgentID: "BILLY666  ", weeklyScroll: "off" },
        Password: "should-not-survive",
      },
    });
    expect(projected.agentId).toBe("BILLY666");
    expect(projected.displayFlags.showPassword).toBe("on");
    expect(projected.displayFlags.showPending).toBe("on");
    expect(projected.weeklyScroll).toBe("off");
    expect(JSON.stringify(projected)).not.toContain("should-not-survive");
  });
});
