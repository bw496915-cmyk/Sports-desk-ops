#!/usr/bin/env bun
/** Drill: parity exit 2 (structural) and 3 (stale + structural combined). */

import {
  runSchemaParityGauntlet,
  schemaParityGauntletOk,
} from "../lib/schema_parity_gauntlet.ts";

async function main(): Promise<number> {
  const results = runSchemaParityGauntlet();
  console.log(JSON.stringify({ scenarios: results }, null, 2));
  if (!schemaParityGauntletOk(results)) {
    console.error("schema:parity-gauntlet: one or more scenarios failed");
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
