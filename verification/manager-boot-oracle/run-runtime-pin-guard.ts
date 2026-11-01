#!/usr/bin/env bun
import { assertPortalRuntimePin } from "../../lib/f402_portal_runtime_pin.ts";

try {
  await assertPortalRuntimePin();
  console.log("manager-boot-oracle: runtime pin matches manifest");
} catch (e) {
  console.error(String(e));
  process.exit(1);
}
