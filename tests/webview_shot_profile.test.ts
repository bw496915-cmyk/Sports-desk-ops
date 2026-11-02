import { describe, expect, test } from "bun:test";

import { parseSignedOutMarkers } from "../scripts/webview_shot_cli.ts";

describe("parseSignedOutMarkers", () => {
  test("keeps the known markers in page order", () => {
    expect(parseSignedOutMarkers(["session-expired", "login-form"])).toEqual([
      "session-expired",
      "login-form",
    ]);
  });

  test("drops anything the page returned that is not a known marker", () => {
    expect(
      parseSignedOutMarkers(["login-form", "logged-in", 1, null, {}]),
    ).toEqual(["login-form"]);
  });

  test("a non-array evaluation result means no markers seen", () => {
    for (const value of [undefined, null, "login-form", { 0: "login-form" }]) {
      expect(parseSignedOutMarkers(value)).toEqual([]);
    }
  });
});
