#!/usr/bin/env bun
/**
 * @file scripts/capture/tls_provenance.ts
 * @description Record the TLS negotiation for a capture target.
 *
 *   bun run capture:tls
 *   bun run capture:tls --host fantasy402.com --json
 *
 * Writes scratch/tls-provenance/<stamp>.json and prints a summary. Read-only: the socket opens,
 * records the handshake, and closes without sending application data.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../../lib/cli_args.ts";
import { formatProvenance, probeTls } from "../../lib/tls_provenance.ts";

const HELP = `
capture:tls — record the TLS handshake facts for a capture target

Options:
  --host <name>      Target host (default: fantasy402.com)
  --port <n>         Port (default: 443)
  --timeout-ms <ms>  Handshake timeout (default: 10000)
  --out <dir>        Output root (default: scratch/tls-provenance)
  --json             Print the record instead of the summary
  -h, --help         This text

Examples:
  bun run capture:tls
  bun run capture:tls --host fantasy402.com --json
  bun run capture:tls --host www.fantasy402.com --port 443

No application data is sent; the socket closes after the handshake.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2), {
  valueFlags: ["--host", "--port", "--timeout-ms", "--out"],
});
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const host = flagValue(parsed, "--host", "fantasy402.com");
const port = Number(flagValue(parsed, "--port", "443")) || 443;
const timeoutMs = Number(flagValue(parsed, "--timeout-ms", "10000")) || 10_000;
const outRoot = flagValue(parsed, "--out", "scratch/tls-provenance");
const json = hasFlag(parsed, "--json");

let provenance;
try {
  provenance = await probeTls({ host, port, timeoutMs });
} catch (error) {
  console.error(`capture:tls: ${(error as Error).message}`);
  console.error(
    "  bun run capture:tls --host fantasy402.com --timeout-ms 20000",
  );
  process.exit(1);
}

const stamp = provenance.measuredAt.replace(/[:.]/g, "-");
const outDir = join(outRoot, stamp);
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, `${host}.json`);
await Bun.write(outPath, `${JSON.stringify(provenance, null, 2)}\n`);

if (json) {
  console.log(JSON.stringify(provenance, null, 2));
} else {
  console.log(formatProvenance(provenance));
  console.error(`capture:tls: wrote ${outPath}`);
}
