/**
 * Registry baseline `tables` vs committed prod-schema.json (sync-prod-dump semantics).
 */

import { canonicalJsonString } from "./canonical_json.ts";
import {
  buildRegistryBaselineProdDump,
  type ProdSchemaDump,
} from "./schema_prod_dump.ts";

export type FixtureTableDriftResult = {
  equal: boolean;
  committedTablesCanonical: string;
  registryTablesCanonical: string;
};

/** Compare fixture `tables` to registry after preserving allowlist + captured_at. */
export function compareFixtureTablesToRegistry(
  existing: ProdSchemaDump,
): FixtureTableDriftResult {
  const synced = buildRegistryBaselineProdDump();
  synced.allowlist = existing.allowlist ?? synced.allowlist;
  synced.captured_at = existing.captured_at;

  const committedTablesCanonical = canonicalJsonString(existing.tables);
  const registryTablesCanonical = canonicalJsonString(synced.tables);

  return {
    equal: committedTablesCanonical === registryTablesCanonical,
    committedTablesCanonical,
    registryTablesCanonical,
  };
}
