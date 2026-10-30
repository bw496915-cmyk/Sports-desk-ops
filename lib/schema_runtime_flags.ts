/**
 * Build-time flags via `bun --define SCHEMA_STRICT:true` etc.
 */

declare const SCHEMA_STRICT: boolean | undefined;
declare const SCHEMA_BINARY_MANIFEST: boolean | undefined;

export function schemaStrictEnabled(): boolean {
  return typeof SCHEMA_STRICT !== "undefined" && SCHEMA_STRICT === true;
}

export function schemaBinaryManifestEnabled(): boolean {
  if (typeof SCHEMA_BINARY_MANIFEST === "undefined") return true;
  return SCHEMA_BINARY_MANIFEST === true;
}
