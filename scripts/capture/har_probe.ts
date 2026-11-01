#!/usr/bin/env bun
/**
 * @file scripts/capture/har_probe.ts
 * @description Probe the report reads with cookies from a HAR — no browser.
 *
 *   bun run capture:har --har scratch/fantasy402.har --ops Pending
 *
 * The WebView path is the only way to read an HttpOnly session that is not exported, but a HAR is
 * enough to replay it, and unlike WebView this runs headless in CI. Results use the same record shape
 * as `capture:f402`, with `authMode: "har-cookie"`.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cookiesFromHar, cookieHeaderFrom } from "../../lib/cookie_jar.ts";
import {
  PROBE_PREFIXES,
  buildProbeBody,
  parseProbePageResult,
  probeSummary,
  probeUrl,
  selectProbeOps,
} from "../../lib/f402_probe.ts";

function flag(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1]! : fallback;
}

const args = process.argv.slice(2);
const harPath = flag(args, "--har", "");
const base = flag(
  args,
  "--base",
  process.env.F402_BASE_URL?.trim() || "https://fantasy402.com",
);
const prefix = flag(args, "--prefix", PROBE_PREFIXES[0]!);
const outRoot = flag(args, "--out", "scratch/f402-probes");
const customerId = flag(
  args,
  "--customer-id",
  process.env.F402_CUSTOMER_ID?.trim() ?? "",
);
const agentId = flag(
  args,
  "--agent-id",
  process.env.F402_AGENT_ID?.trim() ?? "",
);
const opsArg = flag(args, "--ops", "");
const includeUnconfirmed = args.includes("--include-unconfirmed");

if (harPath === "") {
  console.error("capture:har: --har <path> is required");
  process.exit(2);
}

const host = new URL(base).host;
const har: unknown = await Bun.file(harPath).json();
const cookies = cookiesFromHar(har, host);
if (cookies.length === 0) {
  console.error(`capture:har: no cookies for ${host} in ${harPath}`);
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
    `capture:har: --ops matched nothing (available: ${selected.map((op) => op.operation).join(", ")})`,
  );
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(outRoot, stamp);
await mkdir(outDir, { recursive: true });

let transportErrors = 0;
for (const op of ops) {
  const url = probeUrl(base, op, prefix);
  const body =
    customerId !== "" && agentId !== ""
      ? buildProbeBody(op, agentId, customerId)
      : agentId !== ""
        ? buildProbeBody(op, agentId)
        : "";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body,
      redirect: "manual",
    });
    const text = await response.text();
    const result = parseProbePageResult({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      bytes: text.length,
      preview: text.slice(0, 2_000),
    });
    const record = {
      schemaVersion: 1,
      kind: "har-probe",
      capturedAt: new Date().toISOString(),
      operation: op.operation,
      url,
      method: op.method,
      body,
      authMode: "har-cookie",
      readOnlyConfirmed: op.readOnly,
      headersObserved: false,
      cookieNames: cookies.map((cookie) => cookie.name),
      result,
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
