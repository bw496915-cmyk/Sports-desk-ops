import { describe, expect, test } from "bun:test";
import {
  decodeWagerEntities,
  projectLiveWagerRow,
} from "../packages/backend/src/wagers.ts";

describe("decodeWagerEntities", () => {
  test("decodes numeric entities from the portal wire format", () => {
    expect(decodeWagerEntities("Patriots/Lions O 49&#189; -110")).toBe(
      "Patriots/Lions O 49½ -110",
    );
  });

  test("decodes hex and named entities", () => {
    expect(decodeWagerEntities("&#xBD; &amp; &lt;x&gt;")).toBe("½ & <x>");
  });

  test("leaves unknown entities alone", () => {
    expect(decodeWagerEntities("a &bogus; b")).toBe("a &bogus; b");
  });
});

describe("projectLiveWagerRow entity hygiene", () => {
  const deps = {
    parseShortDesc: () => ({
      legs: [{ game: "A &amp; B", pick: "Over 49&#189;" }],
      isLive: false,
    }),
    sharpCustomerIds: new Set<string>(),
  };

  test("decodes event, selection and line display", () => {
    const row = projectLiveWagerRow(
      { WagerNumber: "1", AmountWagered: 1000 },
      0,
      deps as never,
    );
    expect(row.event).toBe("A & B");
    expect(row.selection).toBe("Over 49½");
    expect(row.lineDisplay).toBe("Over 49½");
  });

  test("does not decode the raw ticket writer before sentinel classification", () => {
    const row = projectLiveWagerRow(
      {
        WagerNumber: "2",
        AmountWagered: 1000,
        TicketWriter: "<strong>ALERT</strong>",
      },
      1,
      deps as never,
    );
    expect(row.ticketWriter).toContain("<strong>");
  });
});
