import { describe, expect, test } from "bun:test";

import {
  MANAGER_BOOT_OPERATOR_APPENDIX,
  renderManagerBootRunbookTerminal,
} from "./manager_boot_runbook_render.ts";

describe("manager_boot_runbook_render", () => {
  test("render applies heading and strong hooks", () => {
    const out = renderManagerBootRunbookTerminal("# Title\n\n**gate** wired\n", {
      colors: true,
    });
    expect(out).toContain("Title");
    expect(out).toContain("gate");
    expect(out).toContain("\x1b[");
  });

  test("plain mode omits ANSI escapes", () => {
    const out = renderManagerBootRunbookTerminal("# Title\n\n**bold**\n", {
      colors: false,
    });
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("Title");
    expect(out).toContain("bold");
  });

  test("operator appendix documents probe and ingest", () => {
    expect(MANAGER_BOOT_OPERATOR_APPENDIX).toContain("probe:parse-tree");
    expect(MANAGER_BOOT_OPERATOR_APPENDIX).toContain("manager:ingest-hierarchy");
  });
});
