#!/usr/bin/env bun
/**
 * @file scripts/capture/f402_probe.ts
 * @description Probe the F402 report reads from inside a signed-in WebView page.
 *
 * The session cookie is HttpOnly, so the request must come from the page. The profile directory
 * persists the sign-in, which means later runs start authenticated.
 *
 * Probes are evidence under scratch/ (gitignored). When `--promote-dir <dir>` is passed, any 2xx
 * read-only probe is also converted into a value-free, redacted capture record via `CaptureStore`
 * so `bun run apply:captures` can promote its ledger row directly. When `--backend chrome` and
 * `--sniff-requests` are passed, CDP `Network.requestWillBeSent` passively logs the form-field
 * keys (values redacted) sent by the portal UI.
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
  PROBE_PREFIXES,
  buildProbeBody,
  buildProbeExpression,
  parseProbePageResult,
  probeSummary,
  probeUrl,
  selectProbeOps,
} from "../../lib/f402_probe.ts";
import { preflight } from "../../lib/preflight.ts";
import { htmlToText } from "../../lib/ticket_html.ts";
import { loginF402, MissingF402CredentialsError } from "./f402_login.ts";
import { buildCaptureRecord, CaptureStore } from "./recorder.ts";
import { ManagedWebView } from "./webview.ts";

const VALUE_FLAGS = [
  "--base",
  "--backend",
  "--profile",
  "--out",
  "--promote-dir",
  "--wait-for",
  "--body",
  "--prefix",
  "--ops",
  "--login-wait-ms",
] as const;

const HELP = `
capture:f402 — probe the F402 report reads from a signed-in WebView page

Options:
  --login                 Sign in with F402_AGENT_ID / F402_PASSWORD (or the OS credential store)
  --base <url>            Portal origin (default: F402_BASE_URL or https://fantasy402.com)
  --backend <name>        webkit (default) or chrome (required for --sniff-requests)
  --prefix <path>         Route prefix (default: /cloud/api/Manager)
  --ops <a,b>             Only these operations (default: every confirmed read)
  --body <form>           Override the form body; {customerID} is resolved in-page
  --profile <dir>         Persistent WebView profile (default: scratch/webview-profile)
  --out <dir>             Probe output root (default: scratch/f402-probes)
  --promote-dir <dir>     Write value-free CaptureStore records for 2xx read-only probes
  --sniff-requests        Subscribe to CDP Network.requestWillBeSent (chrome backend) and record form keys
  --wait-for <selector>   Unattended: wait for this selector instead of pressing Enter
  --login-wait-ms <ms>    Login timeout (default: 180000)
  --dry-run               Print the plan; launch nothing
  --no-preflight          Skip the DNS/TLS preflight
  --include-unconfirmed   Include PendingDelete (also needs --i-understand-mutations)
  -h, --help              This text

Examples:
  bun run capture:f402 --dry-run
  bun run capture:f402 --login
  bun run capture:f402 --login --ops Pending --prefix /cloud/api/Report
  bun run capture:f402 --login --promote-dir docs/evidence/captures
  bun run capture:f402 --backend chrome --sniff-requests

Every probe records the body it sent and sets headersObserved:false. Nothing is written to docs/
unless --promote-dir is explicitly supplied.
`.trim();

interface CdpRequestWillBeSent {
  readonly request?: {
    readonly url?: string;
    readonly method?: string;
    readonly postData?: string;
  };
}

export interface SniffedFormTemplate {
  readonly path: string;
  readonly method: string;
  readonly formKeys: readonly string[];
}

/** Extract only form-field keys (never values) from a URL-encoded POST body. */
export function extractFormKeys(postData: string | undefined): string[] {
  if (!postData || postData.trim() === "") return [];
  const keys = new Set<string>();
  for (const [key] of new URLSearchParams(postData)) {
    if (key.trim() !== "") keys.add(key.trim());
  }
  return [...keys].sort();
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: VALUE_FLAGS,
  });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    return 0;
  }

  const base = flagValue(
    parsed,
    "--base",
    process.env.F402_BASE_URL?.trim() || "https://fantasy402.com",
  );
  const backendRaw = flagValue(parsed, "--backend", "webkit").toLowerCase();
  const sniffRequests = hasFlag(parsed, "--sniff-requests");
  const backend: "webkit" | "chrome" =
    backendRaw === "chrome" || sniffRequests ? "chrome" : "webkit";
  const profile = flagValue(parsed, "--profile", "scratch/webview-profile");
  const outRoot = flagValue(parsed, "--out", "scratch/f402-probes");
  const promoteDir = flagValue(parsed, "--promote-dir", "");
  const waitFor = flagValue(parsed, "--wait-for", "");
  const explicitBody = flagValue(parsed, "--body", "");
  const prefix = flagValue(parsed, "--prefix", PROBE_PREFIXES[0]!);
  const opsArg = flagValue(parsed, "--ops", "");
  const loginWaitMs = Number(flagValue(parsed, "--login-wait-ms", "180000"));
  const autoLogin = hasFlag(parsed, "--login");
  const includeUnconfirmed = hasFlag(parsed, "--include-unconfirmed");
  const dryRun = hasFlag(parsed, "--dry-run");

  if (includeUnconfirmed && !hasFlag(parsed, "--i-understand-mutations")) {
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
      `capture:f402: --ops matched nothing. Available: ${selected.map((op) => op.operation).join(", ")}`,
    );
    console.error(
      "  bun run capture:f402 --ops Pending --prefix /cloud/api/Report",
    );
    return 2;
  }

  const agentId = process.env.F402_AGENT_ID?.trim() ?? "";
  const bodyFor = (op: (typeof ops)[number]): string =>
    explicitBody !== ""
      ? explicitBody
      : agentId === ""
        ? ""
        : buildProbeBody(
            op,
            agentId,
            process.env.F402_CUSTOMER_ID?.trim() || "{customerID}",
          );

  if (dryRun) {
    console.error(
      `capture:f402: plan for ${base} (${ops.length} operations, prefix ${prefix}, backend ${backend})`,
    );
    for (const op of ops) {
      const shown =
        agentId === ""
          ? bodyFor(op)
          : bodyFor(op).replaceAll(agentId, "<agent>");
      console.log(
        `${op.operation.padEnd(30)} ${op.method.padEnd(4)} ${probeUrl(base, op, prefix)}  body=${shown}  ${op.readOnly ? "" : "[unconfirmed]"}`,
      );
    }
    console.error("capture:f402: dry run; nothing launched");
    return 0;
  }

  if (!autoLogin && waitFor === "" && !process.stdin.isTTY) {
    console.error("capture:f402: no TTY and no --wait-for selector.");
    console.error(
      "  bun run capture:f402 --login          # F402_AGENT_ID / F402_PASSWORD",
    );
    console.error("  bun run capture:f402 --wait-for 'a[href*=\"logout\"]'");
    return 2;
  }

  if (!hasFlag(parsed, "--no-preflight")) {
    const target = new URL(base).hostname;
    const check = await preflight(target, {
      timeoutMs: Math.min(loginWaitMs, 10_000),
    });
    if (!check.ok) {
      console.error(`capture:f402: ${check.error ?? "preflight failed"}`);
      console.error("  bun run capture:preflight --host " + target);
      return 1;
    }
    console.error(
      `capture:f402: preflight ok · ${check.dns.length} address(es) · ${check.tls?.tlsVersion ?? "?"} ${check.tls?.cipher.name ?? ""}`,
    );
  }

  await using view = ManagedWebView.launch({
    backend,
    dataStoreDir: profile,
    width: 1440,
    height: 900,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(outRoot, stamp);
  const sniffedTemplates: SniffedFormTemplate[] = [];
  let unsubscribeSniffer: (() => void) | null = null;

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
      } else {
        console.error(
          `capture:f402: sign in in the ${backend} window, then press Enter (profile: ${profile})`,
        );
        process.stdin.resume();
        await new Promise<void>((resolve) =>
          process.stdin.once("data", () => resolve()),
        );
        authMode = "interactive";
      }
    }

    if (sniffRequests && backend === "chrome") {
      await view.cdp("Network.enable");
      unsubscribeSniffer = view.onCdpEvent<CdpRequestWillBeSent>(
        "Network.requestWillBeSent",
        (event) => {
          const reqUrl = event.request?.url ?? "";
          if (!reqUrl.includes("/cloud/api/")) return;
          try {
            const parsedUrl = new URL(reqUrl);
            sniffedTemplates.push({
              path: parsedUrl.pathname,
              method: (event.request?.method ?? "POST").toUpperCase(),
              formKeys: extractFormKeys(event.request?.postData),
            });
          } catch {
            // Ignore malformed URLs.
          }
        },
      );
    }

    await mkdir(outDir, { recursive: true });
    const promoteStore =
      promoteDir !== "" ? new CaptureStore({ root: promoteDir }) : null;
    let promotedCount = 0;
    let transportErrors = 0;
    const portalHost = new URL(base).host;

    for (const op of ops) {
      const url = probeUrl(base, op, prefix);
      const body = bodyFor(op);
      try {
        const raw = await view.evaluate(
          buildProbeExpression({ operation: op.operation, url, body }),
        );
        const result = parseProbePageResult(raw);
        const capturedAt = new Date().toISOString();
        const record = {
          schemaVersion: 1,
          kind: "webview-probe",
          capturedAt,
          operation: op.operation,
          url,
          method: op.method,
          body,
          authMode,
          readOnlyConfirmed: op.readOnly,
          headersObserved: false,
          result,
          // Printable endpoints answer HTML; keep a readable excerpt beside the raw preview.
          extractedText: result.contentType.includes("text/html")
            ? htmlToText(result.preview).slice(0, 2_000)
            : null,
          note: op.note,
        };
        await Bun.write(
          join(outDir, `${op.operation}.json`),
          `${JSON.stringify(record, null, 2)}\n`,
        );

        // Promote 2xx read-only probes into value-free CaptureStore records when requested.
        if (
          promoteStore !== null &&
          op.readOnly &&
          result.status >= 200 &&
          result.status <= 299
        ) {
          const opPath = `${prefix.replace(/\/$/, "")}/${op.operation}`;
          const captureRecord = buildCaptureRecord({
            mode: "live",
            capturedAt,
            operation: {
              path: opPath,
              method: "POST",
            },
            request: {
              url,
              method: "POST",
              headers: {
                "content-type":
                  "application/x-www-form-urlencoded; charset=UTF-8",
                "x-requested-with": "XMLHttpRequest",
                authorization: "Bearer <redacted>",
              },
              contentType: "application/x-www-form-urlencoded; charset=UTF-8",
              body,
            },
            response: {
              status: result.status,
              headers: { "content-type": result.contentType },
              contentType: result.contentType,
              bytes: new TextEncoder().encode(result.preview),
            },
            provenance: {
              portalHost,
              proxy: "none",
              auth: "cookie",
              bunVersion: Bun.version,
            },
            samples: 1,
          });
          await promoteStore.write(captureRecord);
          promotedCount += 1;
        }

        const summary = probeSummary(op, result);
        console.log(
          `${summary.operation.padEnd(30)} ${String(summary.status).padEnd(5)} ${summary.verdict.padEnd(8)} ${summary.bytes} B`,
        );
      } catch (error) {
        transportErrors += 1;
        console.error(`${op.operation}: ${(error as Error).message}`);
      }
    }

    if (promoteStore !== null && promotedCount > 0) {
      await promoteStore.finalize();
      console.error(
        `capture:f402: promoted ${promotedCount} 2xx capture(s) into ${promoteDir}`,
      );
    }

    if (sniffedTemplates.length > 0) {
      await Bun.write(
        join(outDir, "_sniffed_form_templates.json"),
        `${JSON.stringify(sniffedTemplates, null, 2)}\n`,
      );
      console.error(
        `capture:f402: recorded ${sniffedTemplates.length} CDP request template(s)`,
      );
    }

    console.error(
      `capture:f402: wrote ${ops.length - transportErrors} probe(s) to ${outDir}`,
    );
    return transportErrors > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof MissingF402CredentialsError) {
      console.error(`capture:f402: ${error.message}`);
      console.error(
        "  bun run secrets:f402 set --agent-id <id>   # then pipe the password on stdin",
      );
      return 2;
    }
    throw error;
  } finally {
    unsubscribeSniffer?.();
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
