#!/usr/bin/env bun
/**
 * Extract gate (j) oracle fixture from a proof-verified redacted manager-boot HAR.
 *
 *   bun run extract:f402-oracle-fixture -- \
 *     --har docs/evidence/captures/har/manager-boot-pipeline-proven.redacted.har.json \
 *     --proof docs/evidence/captures/har/manager-boot-pipeline-proven.redaction-proof.json
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

import { GATE_EXIT_FAILED } from "../../lib/f402_gate_exit.ts";
import { verifyHarRedactionProofFiles } from "../../lib/f402_har_redaction_proof_verify.ts";
import { ProductionFixtureRedactionError } from "../../lib/f402_production_fixture_redaction.ts";
import { prepareProductionOracleFixtureTextFromHar } from "../../lib/f402_production_oracle_fixture_build.ts";
import type { PinnedManifestWithExtracted } from "../../lib/f402_portal_oracle_slice.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const MANIFEST = join(
  REPO_ROOT,
  "verification/manager-boot-oracle/pinned/manifest.json",
);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    har: { type: "string" },
    proof: { type: "string" },
    out: { type: "string" },
    role: { type: "string", default: "operator" },
    dryRun: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`extract:f402-oracle-fixture — proof-verified HAR → production oracle fixture

  --har     Redacted HAR path (default: manifest harRedactionProofGate.harPath)
  --proof   Redaction proof JSON (required unless manifest default exists)
  --out     Output fixture (default: tests/fixtures/f402-general-oracle-production.json)
  --role    _f402Redaction.redactedByRole (default: operator)
  --dry-run Validate only; print byte count to stderr

Load-bearing: verifyHarRedactionProofFiles runs before any extraction (gate w).
`);
  process.exit(0);
}

function resolveRepoPath(path: string): string {
  return path.startsWith("/") ? path : join(REPO_ROOT, path);
}

const manifest = (await Bun.file(MANIFEST).json()) as PinnedManifestWithExtracted;
const harGate = manifest.harRedactionProofGate;

const harPath = resolveRepoPath(
  values.har?.trim() || harGate?.harPath || "",
);
const proofPath = resolveRepoPath(
  values.proof?.trim() || harGate?.proofPath || "",
);

if (proofPath === REPO_ROOT || proofPath === "") {
  console.error(
    JSON.stringify({
      signal: "F402_EXTRACT_PROOF_REQUIRED",
      detail: "pass --proof or commit manifest harRedactionProofGate.proofPath",
    }),
  );
  process.exit(GATE_EXIT_FAILED);
}

if (harPath === REPO_ROOT || harPath === "") {
  console.error(JSON.stringify({ signal: "F402_EXTRACT_HAR_REQUIRED" }));
  process.exit(GATE_EXIT_FAILED);
}

if (!(await Bun.file(proofPath).exists())) {
  console.error(
    JSON.stringify({ signal: "F402_EXTRACT_PROOF_MISSING", proof: proofPath }),
  );
  process.exit(GATE_EXIT_FAILED);
}

if (!(await Bun.file(harPath).exists())) {
  console.error(
    JSON.stringify({ signal: "F402_EXTRACT_HAR_MISSING", har: harPath }),
  );
  process.exit(GATE_EXIT_FAILED);
}

const proofCheck = await verifyHarRedactionProofFiles({
  proofPath,
  harPath,
  requireListAgents: true,
});
if (proofCheck.kind === "failed") {
  console.error(
    JSON.stringify({
      signal: "F402_EXTRACT_PROOF_VERIFY_FAILED",
      gateOutcome: "FAILED",
      ...proofCheck.detail,
      verifySignal: proofCheck.signal,
    }),
  );
  process.exit(GATE_EXIT_FAILED);
}

const outPath =
  values.out?.trim() ||
  join(REPO_ROOT, "tests/fixtures/f402-general-oracle-production.json");
const role = values.role?.trim() || "operator";

let harRoot: unknown;
try {
  harRoot = await Bun.file(harPath).json();
} catch (e) {
  console.error(
    JSON.stringify({ signal: "F402_EXTRACT_HAR_JSON", detail: String(e) }),
  );
  process.exit(GATE_EXIT_FAILED);
}

let fixtureText: string;
try {
  fixtureText = await prepareProductionOracleFixtureTextFromHar(harRoot, role);
} catch (e) {
  const detail =
    e instanceof ProductionFixtureRedactionError
      ? { violations: e.violations }
      : { error: String(e) };
  console.error(JSON.stringify({ signal: "F402_EXTRACT_FIXTURE_FAILED", ...detail }));
  process.exit(GATE_EXIT_FAILED);
}

if (values.dryRun === true) {
  console.error(
    JSON.stringify({
      signal: "F402_EXTRACT_FIXTURE_OK",
      dryRun: true,
      proofVerified: true,
      bytes: fixtureText.length,
      generalRows: (JSON.parse(fixtureText) as { GENERAL: unknown[] }).GENERAL
        .length,
    }),
  );
  process.exit(0);
}

await mkdir(dirname(outPath), { recursive: true });
await Bun.write(outPath, fixtureText);
console.error(
  JSON.stringify({
    signal: "F402_EXTRACT_FIXTURE_WRITTEN",
    out: relative(REPO_ROOT, outPath),
    har: relative(REPO_ROOT, harPath),
    proof: relative(REPO_ROOT, proofPath),
    bytes: fixtureText.length,
    next: "oracle snapshot → pin nestedSnapshotSha256 → bun run verify:manifest-consistency",
  }),
);
