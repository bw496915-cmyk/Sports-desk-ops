import { describe, expect, test } from "bun:test";

import {
  assertRedactedCaptureSweep,
  sweepRedactedCaptureText,
} from "./f402_har_redaction_sweep.ts";
import { PRODUCTION_PASSWORD_SENTINEL } from "./f402_production_fixture_redaction.ts";

describe("HAR redaction sentinel sweep", () => {
  test("passes clean redacted HAR fragment", () => {
    const text = JSON.stringify({
      log: {
        entries: [
          {
            response: {
              content: {
                text: `{"PLAYERS":[{"Password":"${PRODUCTION_PASSWORD_SENTINEL}"}]}`,
              },
            },
          },
        ],
      },
    });
    expect(sweepRedactedCaptureText(text)).toEqual([]);
    expect(() => assertRedactedCaptureSweep(text)).not.toThrow();
  });

  test("fails on Bearer leak", () => {
    const text = '{"x":"Bearer eyJhbGciOiJIUzI1NiJ9"}';
    expect(sweepRedactedCaptureText(text).length).toBeGreaterThan(0);
  });

  test("fails on raw password", () => {
    const text = '{"Password":"supersecret"}';
    expect(sweepRedactedCaptureText(text).some((v) => v.code === "password_leak")).toBe(
      true,
    );
  });
});
