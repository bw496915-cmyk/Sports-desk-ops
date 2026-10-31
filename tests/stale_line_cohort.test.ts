import { describe, expect, test } from "bun:test";
import {
  buildStaleCohortReport,
  normalizeStaleTicket,
  parseStaleTicketInput,
  StaleCohortInputError,
  staleSeedReasons,
} from "../lib/stale_line_cohort.ts";

const AF12_SEED = {
  customer: "AF12",
  agent: "EAST",
  ticketId: "1072093952",
  eventId: "ROT-451",
  market: "SPREAD",
  period: "FG",
  side: "NE",
  priceAmerican: -117,
  stakeUsd: 500,
  placedAt: "2026-10-30T03:52:02.000Z",
  settledAt: "2026-10-30T03:53:09.000Z",
  canceledAt: "2026-10-30T15:14:38.000Z",
  status: "CANCELLED",
  staleNote:
    "Stale lines / Lines should have been down by the time the bet was placed.",
  notedBy: "esteban.sibaja",
  ip: "104.28.10.5",
};

const ROWS = [
  AF12_SEED,
  {
    ...AF12_SEED,
    ticketId: "1072094000",
    eventId: "ROT-700",
    placedAt: "2026-10-30T01:00:00.000Z",
    staleNote: "",
    status: "PAID",
    settledAt: "2026-10-30T03:00:00.000Z",
    canceledAt: undefined,
  },
  {
    ...AF12_SEED,
    customer: "BD12",
    ticketId: "1072094100",
    placedAt: "2026-10-30T03:54:00.000Z",
    staleNote: "",
    status: "PAID",
    settledAt: "2026-10-30T05:00:00.000Z",
    canceledAt: undefined,
    ip: "104.28.10.6",
  },
  {
    ...AF12_SEED,
    customer: "CW77",
    ticketId: "1072094200",
    placedAt: "2026-10-30T03:56:30.000Z",
    staleNote: "",
    status: "OPEN",
    settledAt: undefined,
    canceledAt: undefined,
    ip: "104.28.10.7",
  },
  {
    ...AF12_SEED,
    customer: "FAR99",
    ticketId: "1072094300",
    placedAt: "2026-10-30T04:30:00.000Z",
    staleNote: "",
    status: "OPEN",
    settledAt: undefined,
    canceledAt: undefined,
    ip: "",
  },
  {
    ...AF12_SEED,
    customer: "OTHER1",
    ticketId: "1072095000",
    eventId: "ROT-500",
    placedAt: "2026-10-30T03:52:30.000Z",
    canceledAt: undefined,
    ip: "203.0.113.9",
  },
  {
    ...AF12_SEED,
    customer: "HUMAN1",
    ticketId: "1072096000",
    eventId: "ROT-600",
    placedAt: "2026-10-30T03:50:00.000Z",
    staleNote: "",
    status: "PAID",
    settledAt: "2026-10-30T04:00:00.000Z",
    canceledAt: undefined,
    ip: "198.51.100.4",
  },
];

describe("stale-line cohort detector", () => {
  test("normalizes ISO and epoch timestamps and rejects missing fields", () => {
    const iso = normalizeStaleTicket(
      { customer: "af12", placedAt: "2026-10-30T03:52:02Z" },
      0,
    );
    expect(iso.customer).toBe("AF12");
    expect(iso.placedAtMs).toBe(Date.parse("2026-10-30T03:52:02Z"));

    const seconds = normalizeStaleTicket(
      { customer: "af12", placedAt: 1793259122 },
      0,
    );
    expect(seconds.placedAtMs).toBe(1793259122000);

    expect(() =>
      normalizeStaleTicket({ placedAt: "2026-10-30T03:52:02Z" }, 2),
    ).toThrow(StaleCohortInputError);
    expect(() =>
      normalizeStaleTicket({ customer: "af12", placedAt: "not-a-date" }, 4),
    ).toThrow(/row 5/);
  });

  test("seeds only on an operator stale note or a graded-then-cancelled reversal", () => {
    const seed = normalizeStaleTicket(AF12_SEED, 0);
    expect(staleSeedReasons(seed)).toEqual([
      "operator_stale_note",
      "graded_then_cancelled",
    ]);

    const human = normalizeStaleTicket(
      {
        customer: "X",
        placedAt: 1,
        status: "CANCELLED",
        settledAt: 1,
        canceledAt: 2,
      },
      0,
    );
    // Settled before cancelled, so it is still a reversal seed even without a note.
    expect(staleSeedReasons(human)).toContain("graded_then_cancelled");

    const plain = normalizeStaleTicket(
      { customer: "X", placedAt: 1, status: "OPEN" },
      0,
    );
    expect(staleSeedReasons(plain)).toEqual([]);
  });

  test("clusters same-event tickets around a seed and excludes the far ticket", () => {
    const report = buildStaleCohortReport(ROWS, {
      windowMinutes: 10,
      tickEpochMs: 1,
    });

    expect(report.totals).toEqual({
      tickets: 7,
      seeds: 2,
      clusters: 2,
      customers: 6,
    });

    const event451 = report.clusters.find(
      (cluster) => cluster.eventId === "ROT-451",
    );
    expect(event451).toBeDefined();
    expect(event451?.customerIds).toEqual(["AF12", "BD12", "CW77"]);
    expect(event451?.seedTicketIds).toEqual(["1072093952"]);
    expect(event451?.firstPlacedAtIso).toBe("2026-10-30T03:52:02.000Z");
    expect(event451?.lastPlacedAtIso).toBe("2026-10-30T03:56:30.000Z");
    expect(event451?.spreadSeconds).toBe(268);
    expect(event451?.customerIds).not.toContain("FAR99");

    const event500 = report.clusters.find(
      (cluster) => cluster.eventId === "ROT-500",
    );
    expect(event500?.customerIds).toEqual(["OTHER1"]);

    // Follow-up link lands on the desk day of the placement (22:52 CDT on Oct 29).
    expect(event451?.followUpUrl).toContain("eventId=ROT-451");
    expect(event451?.followUpUrl).toContain("dateFilterBy=betTime");
    expect(event451?.followUpUrl).toContain("from=1793250000");
    expect(event451?.followUpUrl).toContain("t=1");
  });

  test("scores customers and surfaces agent/IP linkage", () => {
    const report = buildStaleCohortReport(ROWS, {
      windowMinutes: 10,
      tickEpochMs: 1,
    });
    const af12 = report.customers.find(
      (customer) => customer.customer === "AF12",
    );
    expect(af12).toEqual({
      customer: "AF12",
      agent: "EAST",
      tickets: 2,
      seeds: 1,
      staleRatePct: 50,
      distinctSeedEvents: 1,
      clusteredTickets: 1,
      canceled: 1,
      gradedThenCanceled: 1,
      stakeFingerprint: [500],
      ip24: ["104.28.10.0/24"],
    });

    const far = report.customers.find(
      (customer) => customer.customer === "FAR99",
    );
    expect(far?.clusteredTickets).toBe(0);

    // AF12, BD12 and CW77 share the /24, which is the linkage hint.
    const shared = report.customers.filter((customer) =>
      customer.ip24.includes("104.28.10.0/24"),
    );
    expect(shared.map((customer) => customer.customer)).toEqual([
      "AF12",
      "BD12",
      "CW77",
    ]);
  });

  test("parses CSV, JSONL and the {tickets: []} wrapper with column aliases", () => {
    const csv = [
      "Login,Event,Ticket,Placed At,Price,Note",
      'AF12,ROT-451,107,2026-10-30T03:52:02Z,-117,"Stale lines, line moved"',
      "BD12,ROT-451,108,2026-10-30T03:54:00Z,-117,",
    ].join("\n");
    const fromCsv = parseStaleTicketInput(csv);
    expect(fromCsv).toHaveLength(2);
    expect(fromCsv[0]?.customer).toBe("AF12");
    expect(fromCsv[0]?.staleNote).toBe("Stale lines, line moved");
    expect(fromCsv[0]?.priceAmerican).toBe("-117");

    const jsonl = [
      JSON.stringify({ customer: "AF12", placedAt: "2026-10-30T03:52:02Z" }),
      JSON.stringify({ customer: "BD12", placedAt: "2026-10-30T03:54:00Z" }),
    ].join("\n");
    expect(parseStaleTicketInput(jsonl)).toHaveLength(2);

    const wrapped = JSON.stringify({
      tickets: [{ customer: "AF12", placedAt: 1793259122 }],
    });
    expect(parseStaleTicketInput(wrapped)).toHaveLength(1);
  });
});
