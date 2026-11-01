#!/usr/bin/env bun
/**
 * Print nested oracle snapshot sha256 for manifest productionOracleGate.nestedSnapshotSha256.
 *
 *   bun run pin:manager-oracle-snapshot
 *   bun run pin:manager-oracle-snapshot -- --fixture tests/fixtures/f402-general-oracle-production.json
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import { parseProductionOracleFixtureText } from "../../lib/f402_production_fixture_redaction.ts";
import {
  oracleSnapshot,
  runPortalHierarchyOracle,
  type PortalGeneralRow,
} from "../../lib/f402_portal_hierarchy_oracle.ts";
import { sha256HexText } from "../../lib/f402_portal_version_pin.ts";
import type { PinnedManifestWithExtracted } from "../../lib/f402_portal_oracle_slice.ts";

const REPO = join(import.meta.dir, "../..");
const MANIFEST = join(import.meta.dir, "pinned/manifest.json");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    fixture: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`pin:manager-oracle-snapshot — emit nestedSnapshotSha256 for manifest

  --fixture  Path (default: manifest productionOracleGate.generalFixture)
`);
  process.exit(0);
}

const manifest = (await Bun.file(MANIFEST).json()) as PinnedManifestWithExtracted;
const rel =
  values.fixture?.trim() || manifest.productionOracleGate?.generalFixture || "";
if (rel === "") {
  console.error(JSON.stringify({ signal: "F402_PIN_FIXTURE_PATH_MISSING" }));
  process.exit(1);
}

const fixturePath = join(REPO, rel);
if (!(await Bun.file(fixturePath).exists())) {
  console.error(JSON.stringify({ signal: "F402_PIN_FIXTURE_MISSING", fixture: rel }));
  process.exit(1);
}

const text = await Bun.file(fixturePath).text();
const fixture = parseProductionOracleFixtureText(text);
const result = await runPortalHierarchyOracle(
  fixture.GENERAL as PortalGeneralRow[],
  { runSetComplete: true },
);
const snap = oracleSnapshot(result.nested);
const hash = await sha256HexText(snap);

console.log(
  JSON.stringify({
    signal: "F402_ORACLE_NESTED_SNAPSHOT",
    fixture: rel,
    generalRowCount: fixture.GENERAL.length,
    nestedSnapshotSha256: hash,
    manifestKey: "productionOracleGate.nestedSnapshotSha256",
  }),
);
