#!/usr/bin/env bun
/**
 * Redact a local scratch copy of getListAgenstByAgent JSON → production oracle fixture.
 * NEVER commit --in. NEVER paste raw JSON into chat or tickets.
 *
 *   bun run redact:f402-envelope -- --in scratch/raw-f402-list-agents.json --out tests/fixtures/...
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { GATE_EXIT_FAILED } from "../../lib/f402_gate_exit.ts";
import { ProductionFixtureRedactionError } from "../../lib/f402_production_fixture_redaction.ts";
import { redactScratchEnvelopeToProductionFixture } from "../../lib/f402_list_agents_envelope_redact.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const SCRATCH_ROOT = join(REPO_ROOT, "scratch");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    in: { type: "string" },
    out: { type: "string" },
    proof: { type: "string" },
    role: { type: "string", default: "operator" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`redact:f402-envelope — scratch envelope → redacted oracle fixture

  --in     Raw DevTools JSON (must live under scratch/ — gitignored)
  --out    Production fixture path (default: tests/fixtures/f402-general-oracle-production.json)
  --proof  Optional proof JSON alongside fixture (payloadSha256 + sweep)
  --role   _f402Redaction.redactedByRole

Security: treat raw --in as credential-bearing. Do not use extract:f402-oracle-fixture on
unproven HAR bytes. Prefer capture:f402-har + verify:manager-har-redaction-proof for gate i′.
`);
  process.exit(0);
}

let inRel = values.in?.trim();
if (inRel === undefined || inRel === "") {
  console.error(JSON.stringify({ signal: "F402_REDACT_IN_REQUIRED" }));
  process.exit(GATE_EXIT_FAILED);
}

let inPath = resolve(REPO_ROOT, inRel);
if (!(await Bun.file(inPath).exists()) && inPath.endsWith(".json")) {
  const savePath = `${inPath}.save`;
  if (await Bun.file(savePath).exists()) inPath = savePath;
}
if (!inPath.startsWith(`${SCRATCH_ROOT}/`)) {
  console.error(
    JSON.stringify({
      signal: "F402_REDACT_IN_NOT_SCRATCH",
      detail: "raw envelope must be under scratch/ (never commit)",
    }),
  );
  process.exit(GATE_EXIT_FAILED);
}

const outPath = resolve(
  REPO_ROOT,
  values.out?.trim() || "tests/fixtures/f402-general-oracle-production.json",
);
const role = values.role?.trim() || "operator";

if (!(await Bun.file(inPath).exists())) {
  console.error(JSON.stringify({ signal: "F402_REDACT_IN_MISSING" }));
  process.exit(GATE_EXIT_FAILED);
}

const rawText = await Bun.file(inPath).text();

let fixtureText: string;
let proof;
try {
  ({ fixtureText, proof } = await redactScratchEnvelopeToProductionFixture({
    rawText,
    redactedByRole: role,
  }));
} catch (e) {
  const detail =
    e instanceof ProductionFixtureRedactionError
      ? { violations: e.violations }
      : { error: String(e) };
  console.error(JSON.stringify({ signal: "F402_REDACT_FAILED", ...detail }));
  process.exit(GATE_EXIT_FAILED);
}

await mkdir(dirname(outPath), { recursive: true });
await Bun.write(outPath, fixtureText);

const proofPath = values.proof?.trim()
  ? resolve(REPO_ROOT, values.proof.trim())
  : `${outPath.replace(/\.json$/i, "")}.envelope-redaction-proof.json`;
await Bun.write(proofPath, `${JSON.stringify(proof, null, 2)}\n`);

console.error(
  JSON.stringify({
    signal: "F402_REDACT_ENVELOPE_OK",
    out: relative(REPO_ROOT, outPath),
    proof: relative(REPO_ROOT, proofPath),
    generalRowCount: proof.generalRowCount,
    playersRowCountSource: proof.playersRowCount,
    extra: proof.extra,
    next: "oracle snapshot → pin nestedSnapshotSha256 → verify:manifest-consistency",
  }),
);
