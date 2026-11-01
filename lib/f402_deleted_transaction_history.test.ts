import { describe, expect, test } from "bun:test";

import {
  parseDeletedTransactionHistoryEnvelope,
  probeCustomerForHistory,
  summarizeDeletedTransactionHistory,
  trimCustomerId,
} from "./f402_deleted_transaction_history.ts";

const fixturePath = new URL(
  "../tests/fixtures/f402-deleted-transaction-history-taco217.json",
  import.meta.url,
);

describe("deleted transaction history envelope", () => {
  test("parses TACO217 fixture and summarizes ledger rows", async () => {
    const raw = await Bun.file(fixturePath).json();
    const envelope = parseDeletedTransactionHistoryEnvelope(raw);
    const summary = summarizeDeletedTransactionHistory(envelope);

    expect(summary.rowCount).toBe(11);
    expect(summary.customerIds).toEqual(["TACO217"]);
    expect(summary.documentNumbers[0]).toBe(842784468);
    expect(summary.documentNumbers.at(-1)).toBe(731380197);
    expect(probeCustomerForHistory(envelope)).toBe("TACO217");
    expect(trimCustomerId(envelope.LIST[0]?.CustomerID)).toBe("TACO217");
    expect(envelope.LIST[0]?.Operation).toBe("Delete");
    expect(envelope.LIST[0]?.Description).toBe("Customer Deposit-jus9");
  });
});
