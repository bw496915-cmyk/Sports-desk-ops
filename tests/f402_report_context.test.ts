import { describe, expect, test } from "bun:test";
import {
  buildReportCustomerContextExpression,
  reportCustomerContextUrl,
} from "../lib/f402_report_context.ts";

describe("f402 report customer context", () => {
  test("builds manager.html URL with CustomerID and AgentView=ON", () => {
    const url = reportCustomerContextUrl("https://fantasy402.com", "CUST1");
    expect(url.startsWith("https://fantasy402.com/manager.html?")).toBe(true);
    expect(url).toContain("CustomerID=CUST1");
    expect(url).toContain("AgentView=ON");
  });

  test("in-page expression sets sessionStorage customerID", () => {
    const expr = buildReportCustomerContextExpression("CUST1");
    expect(expr).toContain('sessionStorage.setItem("customerID"');
    expect(expr).toContain("CUST1");
  });
});
