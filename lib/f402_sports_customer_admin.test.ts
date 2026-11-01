import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  indexSequenceNumbersBySport,
  parseSportsCustomerAdminRows,
  summarizeSportsCustomerAdmin,
  trimSportType,
} from "./f402_sports_customer_admin.ts";

const fixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-sports-customer-admin-snippet.json",
);

describe("getSportsCustomerAdmin rows", () => {
  test("parses top-level array and trims SportType padding", () => {
    const rows = parseSportsCustomerAdminRows(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    expect(rows).toHaveLength(3);
    expect(trimSportType(rows[0]?.SportType)).toBe("Football");
  });

  test("summarize groups rows by sport", () => {
    const rows = parseSportsCustomerAdminRows(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    const summary = summarizeSportsCustomerAdmin(rows);
    expect(summary.rowCount).toBe(3);
    expect(summary.sportTypeCount).toBe(2);
    expect(summary.rowsBySport.Football).toBe(2);
    expect(summary.rowsBySport.Basketball).toBe(1);
  });

  test("indexSequenceNumbersBySport sorts numeric sequence strings", () => {
    const rows = parseSportsCustomerAdminRows(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    expect(indexSequenceNumbersBySport(rows).Football).toEqual([
      "2001",
      "2002",
    ]);
  });
});
