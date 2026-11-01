import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseCustomerAdminListEnvelope,
  redactCustomerAdminListEnvelope,
  summarizeCustomerAdminList,
  trimPaddedField,
} from "./f402_customer_admin_list.ts";

const fixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-customer-admin-list-snippet.json",
);

describe("getCustomerAdmin LIST", () => {
  test("parses padded CustomerID and summarizes pending", () => {
    const env = parseCustomerAdminListEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    expect(trimPaddedField(env.LIST[0]?.CustomerID)).toBe("CB112_1");
    const summary = summarizeCustomerAdminList(env);
    expect(summary.rowCount).toBe(2);
    expect(summary.agentIds).toEqual(["CUB22HR"]);
    expect(summary.rowsWithPending).toBe(2);
    expect(summary.totalPendingWagerBalance).toBe(2721000 + 1690500);
  });

  test("redactCustomerAdminListEnvelope strips Password", () => {
    const env = parseCustomerAdminListEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    const redacted = redactCustomerAdminListEnvelope(env);
    expect(redacted.LIST[0]?.Password).toBe("<redacted>");
  });
});
