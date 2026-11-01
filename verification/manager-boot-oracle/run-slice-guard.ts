#!/usr/bin/env bun
/**
 * Pretest: re-slice pinned manager.js and fail if extracted/*.body.js is stale.
 */
import { assertOracleSlicesFresh } from "../../lib/f402_portal_oracle_slice.ts";
import { assertPortalRuntimePin } from "../../lib/f402_portal_runtime_pin.ts";

try {
  await assertPortalRuntimePin();
  await assertOracleSlicesFresh();
  console.log("manager-boot-oracle: extracted slices match pinned manager.js");
} catch (e) {
  console.error(String(e));
  process.exit(1);
}
