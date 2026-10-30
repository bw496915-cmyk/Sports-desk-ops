/**
 * One-shot: materialize tests/fixtures/fantasy402-sport-catalog-2026-10-21.json
 * from stdin (full catalog JSON). Usage:
 *   bun run scripts/materialize_fantasy402_catalog_fixture.ts < path/to/catalog.json
 */
import { resolve } from "node:path";

const out = resolve(
  import.meta.dir,
  "../tests/fixtures/fantasy402-sport-catalog-2026-10-21.json",
);
const text = await Bun.stdin.text();
const parsed: unknown = JSON.parse(text);
await Bun.write(out, `${JSON.stringify(parsed, null, 2)}\n`);
console.log(`wrote ${out}`);
