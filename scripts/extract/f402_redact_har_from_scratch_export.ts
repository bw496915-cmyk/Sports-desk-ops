#!/usr/bin/env bun
/**
 * DevTools export in scratch (RTF or .txt): leading WebInspector HAR → redacted pipeline artifacts.
 *
 *   textutil -convert txt scratch/export.rtf -output scratch/.tmp-f402-extract.txt
 *   bun run extract:f402-har-from-scratch -- --in scratch/.tmp-f402-extract.txt
 */
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import { GATE_EXIT_FAILED } from "../../lib/f402_gate_exit.ts";
import { buildHarRedactionProof } from "../../lib/f402_har_redaction_sweep.ts";
import { writeRedactedHarFile } from "../../lib/f402_har_redact_stream.ts";
import { urlPathLooksLikeListAgents } from "../../lib/f402_list_agents_url_match.ts";
import type { PinnedManifestWithExtracted } from "../../lib/f402_portal_oracle_slice.ts";

const REPO = join(import.meta.dir, "../..");
const MANIFEST = join(
  REPO,
  "verification/manager-boot-oracle/pinned/manifest.json",
);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    in: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`extract:f402-har-from-scratch — WebInspector HAR prefix → gate i artifacts

  --in  Plain text after textutil (must start with { "log": … }, under scratch/)
`);
  process.exit(0);
}

const inRel = values.in?.trim();
if (inRel === undefined || inRel === "") {
  console.error(JSON.stringify({ signal: "F402_HAR_EXTRACT_IN_REQUIRED" }));
  process.exit(GATE_EXIT_FAILED);
}

const inPath = join(REPO, inRel);
if (!inPath.startsWith(`${join(REPO, "scratch")}/`)) {
  console.error(JSON.stringify({ signal: "F402_HAR_EXTRACT_IN_NOT_SCRATCH" }));
  process.exit(GATE_EXIT_FAILED);
}

const manifest = (await Bun.file(
  MANIFEST,
).json()) as PinnedManifestWithExtracted;
const gate = manifest.harRedactionProofGate;
if (gate === undefined) {
  console.error(JSON.stringify({ signal: "F402_HAR_GATE_MISCONFIG" }));
  process.exit(GATE_EXIT_FAILED);
}

const text = await Bun.file(inPath).text();
const splitAt = text.indexOf('{"GENERAL"');
const harText = (splitAt > 0 ? text.slice(0, splitAt) : text).trim();
let har: { log?: { entries?: { request?: { url?: string } }[] } };
try {
  har = JSON.parse(harText);
} catch (e) {
  console.error(
    JSON.stringify({ signal: "F402_HAR_EXTRACT_PARSE", detail: String(e) }),
  );
  process.exit(GATE_EXIT_FAILED);
}

const entries = har.log?.entries ?? [];
let managerApiEntries = 0;
let listAgentsCaptured = false;
for (const e of entries) {
  const url = e.request?.url ?? "";
  if (url.includes("/cloud/api/Manager/")) managerApiEntries += 1;
  if (urlPathLooksLikeListAgents(url)) listAgentsCaptured = true;
}

const outHar = join(REPO, gate.harPath);
const outProof = join(REPO, gate.proofPath);
await mkdir(join(REPO, "docs/evidence/captures/har"), { recursive: true });

const prepared = await writeRedactedHarFile(outHar, har);
const proof = await buildHarRedactionProof({
  harPath: gate.harPath,
  redactedText: prepared.redactedText,
  entryCount: entries.length,
  managerApiEntries,
  listAgentsCaptured,
});

await Bun.write(outProof, `${JSON.stringify(proof, null, 2)}\n`);

console.error(
  JSON.stringify({
    signal: "F402_HAR_EXTRACT_REDACT_OK",
    in: relative(REPO, inPath),
    har: gate.harPath,
    proof: gate.proofPath,
    entryCount: entries.length,
    listAgentsCaptured,
    sweepOk: proof.sweep.ok,
    next: "set harRedactionProofGate.status ready → verify:manager-har-redaction-proof",
  }),
);
