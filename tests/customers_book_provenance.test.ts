import { describe, expect, test } from "bun:test";
import {
  classifyCustomerBook,
  computeCustomersCohortPayload,
} from "../packages/backend/src/customers.ts";

describe("classifyCustomerBook", () => {
  test("labels a SYNTH-prefixed book as a fixture", () => {
    const book = [{ customer_id: "SYNTH_SYN_01" }, { customer_id: "PEY101" }];
    expect(
      classifyCustomerBook(book, "enriched_customers_full.json").kind,
    ).toBe("fixture");
  });

  test("labels a book under fixtures/ as a fixture even without SYNTH ids", () => {
    const book = [{ customer_id: "C001" }];
    expect(
      classifyCustomerBook(
        book,
        "tests/fixtures/backtest/enriched_customers_full.json",
      ).kind,
    ).toBe("fixture");
  });

  test("carries the file mtime into observedAt when given", () => {
    const provenance = classifyCustomerBook(
      [{ customer_id: "ML284" }],
      "enriched_customers_full.json",
      "2026-11-13T20:00:00.000Z",
    );
    expect(provenance.observedAt).toBe("2026-11-13T20:00:00.000Z");
  });

  test("labels a real-looking book as a capture", () => {
    const book = [{ customer_id: "ML284" }, { customer_id: "HT5009" }];
    const provenance = classifyCustomerBook(
      book,
      "enriched_customers_full.json",
    );
    expect(provenance.kind).toBe("capture");
    expect(provenance.label).toBe("Enriched Local Book + Backtest");
  });
});

describe("computeCustomersCohortPayload book passthrough", () => {
  test("returns the local book rows so the UI can map them", () => {
    const payload = computeCustomersCohortPayload({
      backtestLeaderboard: [],
      fixtures: [{ customer_id: "SYNTH_X" }],
      keyNumberBuyerIds: [],
      hookSyndicateIds: [],
      localBookRows: [{ customer_id: "ML284" }, { customer_id: "HT5009" }],
    });
    expect(payload.book.map((r) => r.customer_id)).toEqual(["ML284", "HT5009"]);
    expect(payload.provenance.kind).toBe("capture");
  });
});

describe("computeCustomersCohortPayload provenance", () => {
  test("a present but empty book is a capture with zero rows", () => {
    const payload = computeCustomersCohortPayload({
      backtestLeaderboard: [],
      fixtures: [{ customer_id: "SYNTH_X" }],
      keyNumberBuyerIds: [],
      hookSyndicateIds: [],
      localBookRows: [],
    });
    expect(payload.provenance.kind).toBe("capture");
    expect(payload.book).toEqual([]);
    expect(payload.cohorts.fullBookSpecCount).toBe(0);
  });

  test("does not claim capture for a synthetic local book", () => {
    const payload = computeCustomersCohortPayload({
      backtestLeaderboard: [],
      fixtures: [],
      keyNumberBuyerIds: [],
      hookSyndicateIds: [],
      localBookRows: [{ customer_id: "SYNTH_SYN_01" }],
    });
    expect(payload.provenance.kind).toBe("fixture");
    expect(payload.provenance.label).toBe("Synthetic Customer Book");
  });
});
