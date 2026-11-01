#!/usr/bin/env bun
/**
 * @file scripts/capture/f402_probe.ts
 * @description Probe the F402 report reads from inside a signed-in WebKit page.
 *
 *   bun run capture:f402 --dry-run
 *   bun run capture:f402 --login                 # unattended, needs F402_AGENT_ID / F402_PASSWORD
 *   bun run capture:f402 --wait-for 'a[href*="logout"]'
 *   bun run capture:f402                         # interactive: sign in, press Enter
 *
 * The session cookie is HttpOnly, so the request has to come from the page. The profile directory
 * persists the sign-in, which means later runs start already authenticated.
 *
 * What this produces is a probe, not a promoted capture: status, content type and a body preview per
 * operation, written under scratch/ (gitignored). Headers are not observed, and nothing is written to
 * docs/ until the shape is confirmed — a 404/405 here is a finding, not a failure.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PROBE_PREFIXES,
  buildProbeBody,
  buildProbeExpression,
  parseProbePageResult,
  probeSummary,
  probeUrl,
  selectProbeOps,
} from "../../lib/f402_probe.ts";
import { loginF402, MissingF402CredentialsError } from "./f402_login.ts";
import { ManagedWebView } from "./webview.ts";

function flag(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1]! : fallback;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const base = flag(
    args,
    "--base",
    process.env.F402_BASE_URL?.trim() || "https://www.fantasy402.com",
  );
  const profile = flag(args, "--profile", "scratch/webview-profile");
  const outRoot = flag(args, "--out", "scratch/f402-probes");
  const waitFor = flag(args, "--wait-for", "");
  const explicitBody = flag(args, "--body", "");
  const prefix = flag(args, "--prefix", PROBE_PREFIXES[0]!);
  const opsArg = flag(args, "--ops", "");
  const loginWaitMs = Number(flag(args, "--login-wait-ms", "180000"));
  const autoLogin = args.includes("--login");
  const includeUnconfirmed = args.includes("--include-unconfirmed");
  const dryRun = args.includes("--dry-run");

  if (includeUnconfirmed && !args.includes("--i-understand-mutations")) {
    console.error(
      "capture:f402: --include-unconfirmed also needs --i-understand-mutations; PendingDelete is not confirmed read-only",
    );
    return 2;
  }

  const selected = selectProbeOps(includeUnconfirmed);
  const wanted =
    opsArg === ""
      ? null
      : new Set(opsArg.split(",").map((name) => name.trim()));
  const ops =
    wanted === null
      ? selected
      : selected.filter((op) => wanted.has(op.operation));
  if (ops.length === 0) {
    console.error(
      `capture:f402: --ops matched nothing (available: ${selected.map((op) => op.operation).join(", ")})`,
    );
    return 2;
  }
  const agentId = process.env.F402_AGENT_ID?.trim() ?? "";
  const bodyFor = (op: (typeof ops)[number]): string =>
    explicitBody !== ""
      ? explicitBody
      : agentId === ""
        ? ""
        : buildProbeBody(op, agentId, process.env.F402_CUSTOMER_ID?.trim());

  if (dryRun) {
    console.error(`capture:f402: plan for ${base} (${ops.length} operations)`);
    for (const op of ops) {
      console.log(
        `${op.operation.padEnd(30)} ${op.method.padEnd(4)} ${probeUrl(base, op, prefix)}  body=${bodyFor(op).replaceAll(agentId === "" ? "\u0000" : agentId, "<agent>")}  ${op.readOnly ? "" : "[unconfirmed]"}`,
      );
    }
    console.error("capture:f402: dry run; nothing launched");
    return 0;
  }

  const view = ManagedWebView.launch({
    backend: "webkit",
    dataStoreDir: profile,
    width: 1440,
    height: 900,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(outRoot, stamp);

  try {
    let authMode: "env-login" | "selector" | "interactive";

    if (autoLogin) {
      await loginF402(view, { baseUrl: base, timeoutMs: loginWaitMs });
      authMode = "env-login";
      console.error(
        "capture:f402: signed in with F402_AGENT_ID / F402_PASSWORD",
      );
    } else {
      await view.navigate(base);
      await view.waitForLoad();

      if (waitFor !== "") {
        await view.waitForSelector(waitFor, { timeoutMs: loginWaitMs });
        authMode = "selector";
        console.error(`capture:f402: signed in (matched ${waitFor})`);
      } else if (process.stdin.isTTY) {
        console.error(
          `capture:f402: sign in in the WebKit window, then press Enter (profile: ${profile})`,
        );
        process.stdin.resume();
        await new Promise<void>((resolve) =>
          process.stdin.once("data", () => resolve()),
        );
        authMode = "interactive";
      } else {
        console.error(
          "capture:f402: no TTY and no --wait-for selector; pass --login with F402_AGENT_ID/F402_PASSWORD, or --wait-for",
        );
        return 2;
      }
    }

    await mkdir(outDir, { recursive: true });
    let transportErrors = 0;

    for (const op of ops) {
      const url = probeUrl(base, op, prefix);
      const body = bodyFor(op);
      try {
        const raw = await view.evaluate(
          buildProbeExpression({ operation: op.operation, url, body }),
        );
        const result = parseProbePageResult(raw);
        const record = {
          schemaVersion: 1,
          kind: "webview-probe",
          capturedAt: new Date().toISOString(),
          operation: op.operation,
          url,
          method: op.method,
          body,
          authMode,
          readOnlyConfirmed: op.readOnly,
          headersObserved: false,
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
      `capture:f402: wrote ${ops.length - transportErrors} probe(s) to ${outDir}`,
    );
    return transportErrors > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof MissingF402CredentialsError) {
      console.error(`capture:f402: ${error.message}`);
      return 2;
    }
    throw error;
  } finally {
    await view.close();
  }
}

process.exitCode = await main();
