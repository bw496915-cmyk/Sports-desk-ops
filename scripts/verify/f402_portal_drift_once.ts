#!/usr/bin/env bun
import { assertNoLivePortalArtifactDrift } from "../../lib/f402_portal_drift_signal.ts";

try {
  await assertNoLivePortalArtifactDrift();
} catch {
  process.exit(1);
}
