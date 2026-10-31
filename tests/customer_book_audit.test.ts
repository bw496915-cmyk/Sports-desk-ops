import { describe, expect, test } from "bun:test";
import { auditCustomerBook } from "../lib/customer_book_audit.ts";

function ticket(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    wager_number: 1,
    selection: "Team A -3.5",
    result: "WIN",
    risk_usd: 110,
    win_usd: 100,
    net_usd: 100,
    ...overrides,
  };
}

function customer(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    customer_id: "C1",
    lifetime_volume_usd: 1_000,
    lifetime_net_usd: 100,
    hold_pct: 10,
    recent_tickets: [ticket()],
    ...overrides,
  };
}

describe("customer book audit", () => {
  test("a coherent book has no issues", () => {
    const audit = auditCustomerBook([
      customer(),
      customer({
        customer_id: "C2",
        lifetime_net_usd: -50,
        hold_pct: -5,
        recent_tickets: [
          ticket({
            wager_number: 2,
            result: "LOSS",
            win_usd: 0,
            net_usd: -110,
          }),
          ticket({ wager_number: 3, result: "VOID", win_usd: 0, net_usd: 0 }),
        ],
      }),
    ]);
    expect(audit.customers).toBe(2);
    expect(audit.tickets).toBe(3);
    expect(audit.issues).toEqual([]);
  });

  test("flags result/net contradictions", () => {
    const audit = auditCustomerBook([
      customer({
        recent_tickets: [
          ticket({ wager_number: 10, result: "WIN", net_usd: -100 }),
          ticket({ wager_number: 11, result: "LOSS", net_usd: 100 }),
          ticket({ wager_number: 12, result: "VOID", net_usd: 5 }),
        ],
      }),
    ]);
    expect(audit.byKind.RESULT_NET_MISMATCH).toBe(3);
  });

  test("flags hold_pct that does not equal net/volume", () => {
    const audit = auditCustomerBook([
      customer({
        lifetime_volume_usd: 1_000,
        lifetime_net_usd: -70,
        hold_pct: 7.09,
      }),
    ]);
    expect(audit.byKind.HOLD_PCT_MISMATCH).toBe(1);
    expect(audit.issues[0]?.detail).toContain("-7.00");
  });

  test("flags unknown results, non-finite amounts and duplicate wagers", () => {
    const audit = auditCustomerBook([
      customer({
        recent_tickets: [
          ticket({ wager_number: 20, result: "PENDING", net_usd: 0 }),
          ticket({ wager_number: 21, net_usd: Number.NaN }),
        ],
      }),
      customer({
        customer_id: "C2",
        lifetime_net_usd: 100,
        recent_tickets: [ticket({ wager_number: 20, selection: "Team B +2" })],
      }),
    ]);
    expect(audit.byKind.UNKNOWN_RESULT).toBe(1);
    expect(audit.byKind.NON_FINITE_AMOUNT).toBeGreaterThanOrEqual(1);
    expect(audit.byKind.DUPLICATE_WAGER_NUMBER).toBe(1);
    expect(audit.errors).toBeGreaterThanOrEqual(2);
    expect(audit.warnings).toBe(1);
  });

  test("same wager number on the same customer/selection is not a duplicate", () => {
    const audit = auditCustomerBook([
      customer({
        recent_tickets: [
          ticket({ wager_number: 30 }),
          ticket({ wager_number: 30 }),
        ],
      }),
    ]);
    expect(audit.byKind.DUPLICATE_WAGER_NUMBER).toBe(0);
  });
});
