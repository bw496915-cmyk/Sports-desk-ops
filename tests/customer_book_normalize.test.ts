import { describe, expect, test } from "bun:test";
import { normalizeCustomerBook } from "../lib/customer_book_normalize.ts";

function book(): Record<string, unknown>[] {
  return [
    {
      customer_id: "C1",
      lifetime_volume_usd: 1_000,
      lifetime_net_usd: -70,
      hold_pct: 7.09,
      recent_tickets: [
        {
          wager_number: 1,
          result: "WIN",
          risk_usd: 110,
          win_usd: 100,
          net_usd: -100,
        },
        {
          wager_number: 2,
          result: "LOSS",
          risk_usd: 110,
          win_usd: 0,
          net_usd: 110,
        },
        {
          wager_number: 3,
          result: "VOID",
          risk_usd: 110,
          win_usd: 0,
          net_usd: 42,
        },
        {
          wager_number: 4,
          result: "PENDING",
          risk_usd: 110,
          win_usd: 0,
          net_usd: 7,
        },
      ],
    },
  ];
}

describe("customer book normalization", () => {
  test("derives ticket net from result and recomputes hold_pct", () => {
    const result = normalizeCustomerBook(book());
    const row = result.rows[0] as Record<string, unknown>;
    const tickets = row.recent_tickets as Array<Record<string, unknown>>;
    expect(tickets[0]?.net_usd).toBe(100);
    expect(tickets[1]?.net_usd).toBe(-110);
    expect(tickets[2]?.net_usd).toBe(0);
    expect(tickets[3]?.net_usd).toBe(7); // unknown result untouched
    expect(row.hold_pct).toBe(-7);
    expect(result.changes.filter((c) => c.kind === "HOLD_PCT")).toHaveLength(1);
    expect(result.changes.filter((c) => c.kind === "TICKET_NET")).toHaveLength(
      3,
    );
  });

  test("does not mutate the input rows", () => {
    const input = book();
    normalizeCustomerBook(input);
    const tickets = (input[0] as Record<string, unknown>)
      .recent_tickets as Array<Record<string, unknown>>;
    expect(tickets[0]?.net_usd).toBe(-100);
    expect((input[0] as Record<string, unknown>).hold_pct).toBe(7.09);
  });

  test("is idempotent", () => {
    const once = normalizeCustomerBook(book());
    const twice = normalizeCustomerBook(once.rows);
    expect(twice.changes).toEqual([]);
    expect(twice.rows).toEqual(once.rows);
  });
});
