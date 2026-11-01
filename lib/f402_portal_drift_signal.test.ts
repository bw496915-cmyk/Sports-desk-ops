import { describe, expect, test } from "bun:test";

import {
  F402_PORTAL_ARTIFACT_DRIFT_SIGNAL,
  PortalArtifactDriftError,
} from "./f402_portal_drift_signal.ts";

describe("portal artifact drift signal", () => {
  test("error carries stable signal id", () => {
    const err = new PortalArtifactDriftError(["manager.js hash x != y"]);
    expect(err.signal).toBe(F402_PORTAL_ARTIFACT_DRIFT_SIGNAL);
    expect(err.message).toContain(F402_PORTAL_ARTIFACT_DRIFT_SIGNAL);
  });
});
