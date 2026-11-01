#!/usr/bin/env bun
/**
 * @file scripts/capture/har_probe.ts
 * @description Probe the report reads with cookies (and bearer token) from a HAR — no browser.
 *
 * The WebView path is the only way to read an HttpOnly session that was never exported, but a HAR
 * is enough to replay it, and unlike WebView this runs headless in CI.
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
import {
  bearerFromHar,
  cookiesFromHar,
  cookieHeaderFrom,
} from "../../lib/cookie_jar.ts";
import { preflight } from "../../lib/preflight.ts";
import { htmlToText } from "../../lib/ticket_html.ts";
import {
  PROBE_PREFIXES,
  buildProbeBody,
  parseProbePageResult,
  probeSummary,
  probeUrl,
  selectProbeOps,
} from "../../lib/f402_probe.ts";

const VALUE_FLAGS = [
  "--har",
  "--base",
  "--prefix",
  "--out",
  "--ops",
  "--agent-id",
  "--customer-id",
] as const;

const HELP = `
capture:har — probe the F402 report reads with cookies from a HAR (no browser)

Options:
  --har <path>            HAR file to read cookies from (required)
  --base <url>            Portal origin (default: F402_BASE_URL or https://fantasy402.com)
  --prefix <path>         Route prefix (default: /cloud/api/Manager)
  --ops <a,b>             Only these operations
  --agent-id <id>         Manager agent id for the form body (default: F402_AGENT_ID)
  --customer-id <id>      Customer id for the form body (default: F402_CUSTOMER_ID)
  --out <dir>             Probe output root (default: scratch/f402-probes)
  --dry-run               Print what would be sent; make no requests
  --no-preflight          Skip the DNS/TLS preflight
  --include-unconfirmed   Include PendingDelete
  -h, --help              This text

Examples:
  bun run capture:har --har scratch/fantasy402.har --dry-run
  bun run capture:har --har scratch/fantasy402.har --ops Pending
  bun run capture:har --har scratch/fantasy402.har --prefix /cloud/api/Report \\
    --agent-id 118 --customer-id 12345

The HAR must contain a request to the target host with a Cookie header (or Set-Cookie response).
Values are never printed; only cookie names are recorded.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: VALUE_FLAGS });
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const harPath = flagValue(parsed, "--har", "");
const base = flagValue(
  parsed,
  "--base",
  process.env.F402_BASE_URL?.trim() || "https://fantasy402.com",
);
const prefix = flagValue(parsed, "--prefix", PROBE_PREFIXES[0]!);
const outRoot = flagValue(parsed, "--out", "scratch/f402-probes");
const customerId = flagValue(
  parsed,
  "--customer-id",
  process.env.F402_CUSTOMER_ID?.trim() ?? "",
);
const agentId = flagValue(
  parsed,
  "--agent-id",
  process.env.F402_AGENT_ID?.trim() ?? "",
);
const opsArg = flagValue(parsed, "--ops", "");
const includeUnconfirmed = hasFlag(parsed, "--include-unconfirmed");
const dryRun = hasFlag(parsed, "--dry-run");

if (harPath === "") {
  console.error("capture:har: --har is required.");
  console.error(
    "  bun run capture:har --har scratch/fantasy402.har --ops Pending",
  );
  process.exit(2);
}

const host = new URL(base).host;
const har: unknown = await Bun.file(harPath).json();
const cookies = cookiesFromHar(har, host);
const bearer = bearerFromHar(har, host);
if (cookies.length === 0) {
  console.error(`capture:har: no Cookie header for ${host} in ${harPath}.`);
  console.error("  Export a HAR while signed in to the portal, then retry.");
  process.exit(2);
}
const cookieHeader = cookieHeaderFrom(
  cookies.map((cookie) => [cookie.name, cookie.value] as const),
);

const selected = selectProbeOps(includeUnconfirmed);
const wanted =
  opsArg === "" ? null : new Set(opsArg.split(",").map((name) => name.trim()));
const ops =
  wanted === null
    ? selected
    : selected.filter((op) => wanted.has(op.operation));
if (ops.length === 0) {
  console.error(
    `capture:har: --ops matched nothing. Available: ${selected.map((op) => op.operation).join(", ")}`,
  );
  process.exit(2);
}

const bodyFor = (op: (typeof ops)[number]): string =>
  agentId === "" ? "" : buildProbeBody(op, agentId, customerId);

if (dryRun) {
  console.error(
    `capture:har: ${host} · ${cookies.length} cookie(s): ${cookies.map((cookie) => cookie.name).join(", ")}${bearer ? " · bearer: present" : ""}`,
  );
  for (const op of ops) {
    console.log(
      `${op.operation.padEnd(30)} POST ${probeUrl(base, op, prefix)}  body=${bodyFor(op)}`,
    );
  }
  console.error("capture:har: dry run; no requests made");
  process.exit(0);
}

let tls: Awaited<ReturnType<typeof preflight>>["tls"] = null;
if (!hasFlag(parsed, "--no-preflight")) {
  const check = await preflight(host);
  if (!check.ok) {
    console.error(`capture:har: ${check.error ?? "preflight failed"}`);
    console.error("  bun run capture:preflight --host " + host);
    process.exit(1);
  }
  tls = check.tls;
  console.error(
    `capture:har: preflight ok · ${check.dns.length} address(es) · ${check.tls?.tlsVersion ?? "?"}`,
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(outRoot, stamp);
await mkdir(outDir, { recursive: true });
await Bun.write(
  join(outDir, "run.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "probe-run",
      startedAt: new Date().toISOString(),
      base,
      prefix,
      authMode: "har-cookie",
      tls,
      ops: ops.map((op) => op.operation),
    },
    null,
    2,
  )}\n`,
);

let transportErrors = 0;
for (const op of ops) {
  const url = probeUrl(base, op, prefix);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        ...(bearer === null ? {} : { authorization: bearer }),
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: bodyFor(op),
      redirect: "manual",
    });
    const rawBytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(rawBytes);
    const result = parseProbePageResult({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      bytes: rawBytes.byteLength,
      preview: text.slice(0, 2_000),
    });
    const record = {
      schemaVersion: 1,
      kind: "har-probe",
      capturedAt: new Date().toISOString(),
      operation: op.operation,
      url,
      method: op.method,
      body: bodyFor(op),
      authMode: "har-cookie",
      readOnlyConfirmed: op.readOnly,
      headersObserved: false,
      cookieNames: cookies.map((cookie) => cookie.name),
      bearerObserved: bearer !== null,
      result,
      extractedText: result.contentType.includes("text/html")
        ? htmlToText(result.preview).slice(0, 2_000)
        : null,
      note: op.note,
    };
    await Bun.write(
      join(outDir, `${op.operation}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    const summary = probeSummary(op, result);
    console.log(
      `${summary.operation.padEnd(30)} ${String(summary.status).padEnd(5)} ${summary.verdict.padEnd(8)} ${summary.bytes} B`,
    );
  } catch (error) {
    transportErrors += 1;
    console.error(`${op.operation}: ${(error as Error).message}`);
  }
}

console.error(
  `capture:har: wrote ${ops.length - transportErrors} probe(s) to ${outDir}`,
);
process.exitCode = transportErrors > 0 ? 1 : 0;
