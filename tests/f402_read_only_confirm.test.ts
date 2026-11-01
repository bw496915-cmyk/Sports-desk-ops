import { describe, expect, test } from "bun:test";
import {
  CLIENT_JS_CONFIRMED_READ_ONLY_OPS,
  isProbeReadOnlyConfirmed,
  PROBE_OPS,
} from "../lib/f402_probe.ts";

describe("isProbeReadOnlyConfirmed", () => {
  test("PendingDelete is confirmed read-only in client JS despite readOnly:false gate", () => {
    const op = PROBE_OPS.find((item) => item.operation === "PendingDelete");
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(op.readOnly).toBe(false);
    expect(CLIENT_JS_CONFIRMED_READ_ONLY_OPS.has("PendingDelete")).toBe(true);
    expect(isProbeReadOnlyConfirmed(op)).toBe(true);
  });
});
