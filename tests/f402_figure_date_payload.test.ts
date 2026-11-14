/**
 * The enricher must parse what the capture path saves.
 *
 * Fixture: tests/fixtures/f402-get-wagers-by-figure-date.sample.json — a shape sample, not a
 * capture (it mirrors the inline fixture in f402_figure_date_enricher.test.ts). The point is the
 * envelope: `{ LIST: { INFO: [...] } }`, the way the portal returns it.
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  enrichWagerRecord,
  parseFigureDateWagersPayload,
  type LiveTickerWager,
} from "../lib/f402_figure_date_enricher.ts";

const FIXTURE = resolve(
  import.meta.dir,
  "fixtures/f402-get-wagers-by-figure-date.sample.json",
);

const ticker: LiveTickerWager = {
  WagerNumber: 767671201,
  AgentID: "DAN318",
  AgentLogin: "DAN318",
  CustomerID: "DAN245    ",
  Login: "DAN245",
  WagerType: "S",
  AmountWagered: 230000,
  ToWinAmount: 200000,
  VolumeAmount: 200000,
  InsertDateTime: "2026-11-06 20:09:35.080",
  TicketWriter: "Internet",
  ShortDesc: "S.Basketball #546 Grizzlies +1 -115 - For 1st Quarter",
  VIP: "0         ",
};

describe("getWagersByFigureDate payload", () => {
  it("parses the saved LIST.INFO envelope and enriches a ticker row", async () => {
    const raw = (await Bun.file(FIXTURE).json()) as unknown;
    const rows = parseFigureDateWagersPayload(raw);
    expect(rows.length).toBe(1);
    expect(rows[0]?.TicketNumber).toBe(1075710577);

    const enriched = enrichWagerRecord(ticker, rows[0]!);
    expect(enriched.ticketNumber).toBe("1075710577");
    expect<string>(enriched.customerId).toBe("DAN245");
    expect(enriched.eventId).toBe(
      "NBA-20261106-OklahomaCityThunder@MemphisGrizzlies",
    );
    expect(enriched.latencySeconds).toBe(25);
    expect(enriched.isLateSteam).toBe(true);
    expect(enriched.marketType).toBe("spread");
  });

  it("accepts the array and rows[] envelopes too", () => {
    const row = { WagerNumber: 1 };
    expect(parseFigureDateWagersPayload([row])).toEqual([row] as never);
    expect(parseFigureDateWagersPayload({ rows: [row] })).toEqual([
      row,
    ] as never);
  });

  it("throws on an envelope it cannot read", () => {
    expect(() => parseFigureDateWagersPayload({ LIST: {} })).toThrow(
      /unrecognised getWagersByFigureDate payload/,
    );
    expect(() => parseFigureDateWagersPayload(null)).toThrow();
  });
});
