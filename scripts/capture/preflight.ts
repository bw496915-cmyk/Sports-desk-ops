#!/usr/bin/env bun
/**
 * @file scripts/capture/preflight.ts
 * @description Resolve and handshake the capture target before a run.
 *
 *   bun run capture:preflight
 *   bun run capture:preflight --host www.fantasy402.com --json
 */

import {
  hasFlag,
  flagValue,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../../lib/cli_args.ts";
import { formatPreflight, preflight } from "../../lib/preflight.ts";

const HELP = `
capture:preflight — DNS and TLS check for a capture target

Options:
  --host <name>      Target host (default: fantasy402.com)
  --port <n>         Port (default: 443)
  --timeout-ms <ms>  Handshake timeout (default: 10000)
  --json             Print the full result
  -h, --help         This text

Examples:
  bun run capture:preflight
  bun run capture:preflight --host www.fantasy402.com
  bun run capture:preflight --json

Exit codes: 0 reachable, 1 DNS or TLS failure, 2 usage.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2), {
  valueFlags: ["--host", "--port", "--timeout-ms"],
});
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const host = flagValue(parsed, "--host", "fantasy402.com");
const port = Number(flagValue(parsed, "--port", "443")) || 443;
const timeoutMs = Number(flagValue(parsed, "--timeout-ms", "10000")) || 10_000;

const result = await preflight(host, { port, timeoutMs });

if (hasFlag(parsed, "--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatPreflight(result));
}

if (!result.ok) {
  console.error("  bun run capture:preflight --host fantasy402.com");
  process.exit(1);
}
