import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeOnOffFlag,
  parseConfigWebReportsCustomerAdminEnvelope,
  summarizeConfigWebReportsCustomerAdmin,
} from "./f402_config_web_reports_customer_admin.ts";

const fixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-config-web-reports-customer-admin.json",
);

describe("getConfigWebReportsCustomerAdmin INFO", () => {
  test("parses column visibility flags with padding", () => {
    const env = parseConfigWebReportsCustomerAdminEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    expect(normalizeOnOffFlag(env.INFO.Password)).toBe("off");
    expect(normalizeOnOffFlag(env.INFO.Available)).toBe("on");
  });

  test("summarize splits on/off columns and show* sections", () => {
    const env = parseConfigWebReportsCustomerAdminEnvelope(
      JSON.parse(readFileSync(fixture, "utf8")),
    );
    const summary = summarizeConfigWebReportsCustomerAdmin(env);
    expect(summary.sortCustom).toBe("1");
    expect(summary.columnFlagsOff).toContain("Password");
    expect(summary.columnFlagsOff).toContain("MaxMoneyLine");
    expect(summary.columnFlagsOn).toContain("Balance");
    expect(summary.showSectionOn).toContain("showSportsbookStatus");
    expect(summary.showSectionOn).toContain("showWagerLimit");
  });
});
