import { describe, expect, test } from "bun:test";

import {
  dedupeDeletedWagerTargets,
  redactDeletedWagerEnvelope,
} from "./f402_deleted_wager_list.ts";

describe("f402_deleted_wager_list", () => {
  test("dedupes parlay legs to one ticket target", () => {
    const targets = dedupeDeletedWagerTargets([
      {
        TicketNumber: "1072976954",
        customerID: "BJ302     ",
        Login: "BJ302",
        DeleteDateTime: "2026-11-01 00:08:16.527",
        AmountWagered: "200.0",
        WagerType: "P",
        WagerCount: "6",
        totalPicks: "6",
        LoginID: "BUYOUT-BJ302",
        NameFirst: "Daymond Johnson",
        Password: "bonds",
      },
      {
        TicketNumber: "1072976954",
        customerID: "BJ302     ",
        Login: "BJ302",
        DeleteDateTime: "2026-11-01 00:08:16.527",
        AmountWagered: "200.0",
        WagerType: "P",
        WagerCount: "6",
        totalPicks: "6",
        LoginID: "BUYOUT-BJ302",
        NameFirst: "Daymond Johnson",
        Password: "bonds",
      },
    ] as never[]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.legCount).toBe(2);
    expect(targets[0]?.customerId).toBe("BJ302");
  });

  test("redact strips Password", () => {
    const redacted = redactDeletedWagerEnvelope({
      INFO: {
        LIST: [
          {
            TicketNumber: "1",
            Password: "secret",
          } as never,
        ],
      },
    });
    expect(
      (redacted.INFO.LIST[0] as { Password?: string }).Password,
    ).toBeUndefined();
  });
});
