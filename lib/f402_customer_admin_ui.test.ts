import { describe, expect, test } from "bun:test";

import {
  F402_CUSTOMER_ADMIN_EXCEL_EXPORT_SELECTOR,
  F402_CUSTOMER_ADMIN_PARTIALS,
  buildLoadCustomerAdminPartialExpression,
  buildProbeCustomerAdminExcelExportExpression,
  customerAdminAsyncPartialUrl,
  customerAdminPartialUrl,
  resolveCustomerAdminPartialFile,
} from "./f402_customer_admin_ui.ts";

describe("customer-admin async partial URLs", () => {
  test("builds player-info-me-setting URL with async=true", () => {
    const url = customerAdminAsyncPartialUrl(
      "https://www.fantasy402.com/manager.html",
      F402_CUSTOMER_ADMIN_PARTIALS.playerInfoMeSetting,
      1793508118726,
    );
    expect(url).toBe(
      "https://www.fantasy402.com/app/ui/component/manager/module/customer-admin/player-info-me-setting.html?v=1793508118726&async=true",
    );
  });

  test("modal-agent-list partial uses async=true", () => {
    const url = customerAdminPartialUrl(
      "https://www.fantasy402.com",
      "modalAgentList",
      { bust: 1793508418345 },
    );
    expect(url).toBe(
      "https://www.fantasy402.com/app/ui/component/manager/module/customer-admin/modal-agent-list.html?v=1793508418345&async=true",
    );
  });

  test("header partial uses async=true", () => {
    const url = customerAdminPartialUrl(
      "https://www.fantasy402.com",
      "header",
      { bust: 1793508118616 },
    );
    expect(url).toBe(
      "https://www.fantasy402.com/app/ui/component/manager/module/customer-admin/header.html?v=1793508118616&async=true",
    );
  });

  test("player-info-modals defaults to async=false", () => {
    const url = customerAdminPartialUrl(
      "https://www.fantasy402.com",
      "playerInfoModals",
      { bust: 1793508118827 },
    );
    expect(url).toBe(
      "https://www.fantasy402.com/app/ui/component/manager/module/customer-admin/player-info-modals.html?v=1793508118827&async=false",
    );
  });

  test("resolveCustomerAdminPartialFile accepts keys and filenames", () => {
    expect(resolveCustomerAdminPartialFile("playerInfoMeSetting")).toBe(
      "player-info-me-setting.html",
    );
    expect(resolveCustomerAdminPartialFile("player-info.html")).toBe(
      "player-info.html",
    );
  });

  test("excel export selector matches customer-admin markup hook", () => {
    expect(F402_CUSTOMER_ADMIN_EXCEL_EXPORT_SELECTOR).toBe(
      '[data-export="excel-action"]',
    );
    const expr = buildProbeCustomerAdminExcelExportExpression();
    expect(expr).toContain("excel-action");
    expect(expr).toContain("getComputedStyle");
  });

  test("load expression uses credentials and XHR accept", () => {
    const expr = buildLoadCustomerAdminPartialExpression(
      "https://www.fantasy402.com/app/ui/component/manager/module/customer-admin/player-info.html?v=1&async=true",
    );
    expect(expr).toContain('credentials: "include"');
    expect(expr).toContain("*/*");
    expect(expr).toContain("XMLHttpRequest");
  });
});
