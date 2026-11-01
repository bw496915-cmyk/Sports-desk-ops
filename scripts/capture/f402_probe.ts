#!/usr/bin/env bun
/**
 * @file scripts/capture/f402_probe.ts
 * @description Probe the F402 report and manager.html boot reads from inside a signed-in WebView page (WebKit or Chrome).
 *
 * The session cookie is HttpOnly, so the request must come from the page. The profile directory
 * persists the sign-in, which means later runs start authenticated.
 *
 * Capabilities on both `webkit` (macOS default, zero deps) and `chrome`:
 * - DNS + TLS preflight (`lib/preflight.ts`) recorded into `run.json` alongside probe outputs.
 * - `--suite <report|manager-boot|all>`: Selects the 7 report ops, the 9 `manager.html` (`v1.0.280`)
 *   boot ops (`getAccountInfoOwner`, `getConfigWebReports`, `getConfigWebReportsPending`, `getSportsType`,
 *   `getAuthorizations`, `getMessage`, `getNewEmailsCount`, `getWeeklyFigureByAgentLite`,
 *   `getListAgenstByAgent`), or both.
 * - Automatic `contentType: "application/json"` dispatch for `getAccountInfoOwner` (`manager.js:31200`)
 *   and `getDailyFiguresByCustomer` (`report.js:25633`), or explicit override via `--json-body`.
 * - `--sniff-requests`: Installs an in-page `XMLHttpRequest` + `fetch` interceptor on WebKit (and
 *   additionally subscribes to CDP `Network.requestWillBeSent` on Chrome) to record `/cloud/api/`
 *   form-field or JSON key templates (`_sniffed_form_templates.json`, values never recorded).
 * - `--screenshot` / `--screenshot-format <png|jpeg|webp>` / `--screenshot-resize <WxH|W>`:
 *   Captures a viewport proof screenshot formatted and resized in-memory via `Bun.Image`
 *   (`lib/screenshot_encode.ts`), so WebP and resizing work natively on WebKit.
 * - `--promote-dir <dir>`: Converts 2xx read-only probes into value-free, redacted `CaptureStore`
 *   records ready for `bun run apply:captures`.
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
  type ProbeSuite,
  type ProbeWireContentType,
  type SniffedFormTemplate,
  buildInstallRequestSnifferExpression,
  buildJsonProbeBody,
  PROBE_OPS,
  buildProbeBody,
  buildProbeExpression,
  buildReadRequestSnifferExpression,
  parseProbePageResult,
  parseSniffedTemplates,
  probeSummary,
  probeUrl,
  selectProbeOps,
} from "../../lib/f402_probe.ts";
import { preflight } from "../../lib/preflight.ts";
import {
  parseResize,
  type ScreenshotFormat,
} from "../../lib/screenshot_encode.ts";
import { htmlToText } from "../../lib/ticket_html.ts";
import {
  loginF402,
  MissingF402CredentialsError,
  SECRET_NAMES,
  SECRETS_SERVICE,
} from "./f402_login.ts";
import { buildCaptureRecord, CaptureStore } from "./recorder.ts";
import { ManagedWebView } from "./webview.ts";

const VALUE_FLAGS = [
  "--base",
  "--backend",
  "--profile",
  "--out",
  "--promote-dir",
  "--from-probes",
  "--screenshot-format",
  "--screenshot-resize",
  "--screenshot-quality",
  "--wait-for",
  "--body",
  "--week",
  "--week-sweep",
  "--ticket",
  "--wager",
  "--flag",
  "--prefix",
  "--suite",
  "--ops",
  "--login-wait-ms",
] as const;

const HELP = `
capture:f402 — probe the F402 report and manager.html boot reads from a signed-in WebKit or Chrome page

Options:
  --login                       Sign in with F402_AGENT_ID / F402_PASSWORD (or the OS credential store)
  --base <url>                  Portal origin (default: F402_BASE_URL or https://fantasy402.com)
  --backend <name>              webkit (macOS default, zero deps) or chrome
  --suite <name>                report (default) | manager-boot (9 v1.0.280 boot ops) | all
  --prefix <path>               Route prefix (default: /cloud/api/Manager)
  --ops <a,b>                   Only these operations (searches across report + manager-boot ops)
  --json-body                   Force application/json request serialization (auto-enabled for getAccountInfoOwner & getDailyFiguresByCustomer)
  --body <form>                 Override the request body; __CUSTOMER_ID__ is resolved in-page
  --week <value>                Candidate for the 'week' field (default: "0" per report.js)
  --ticket <number>             TicketNumber override for getTicketDetailPrint / PendingDelete (default: -1 for PendingDelete)
  --wager <number>              WagerNumber override for getTicketDetailPrint
  --flag <value>                flag override for getTicketDetailPrint
  --profile <dir>               Persistent WebView profile (default: scratch/webview-profile)
  --out <dir>                   Probe output root (default: scratch/f402-probes)
  --promote-dir <dir>           Write value-free CaptureStore records for 2xx read-only probes
  --from-probes <p1,p2,...>     Promote specific existing 2xx probe JSON files into --promote-dir (fails closed on non-2xx)
  --sniff-requests              Record /cloud/api/ form-field/JSON keys (in-page XHR/fetch on webkit, +CDP on chrome)
  --screenshot                  Save a Bun.Image-formatted proof screenshot (_page.<ext>) in the probe dir
  --screenshot-format <fmt>     png | jpeg | webp (default: webp; encoded via Bun.Image on webkit)
  --screenshot-resize <WxH|W>   Resize proof screenshot via Bun.Image (fit: "inside", withoutEnlargement)
  --screenshot-quality <1-100>  jpeg/webp quality for proof screenshot (default: 82)
  --wait-for <selector>         Unattended: wait for this selector instead of pressing Enter
  --login-wait-ms <ms>          Login timeout (default: 180000)
  --dry-run                     Print the plan; launch nothing
  --jsonl                       Write probe results as JSONL (one JSON object per line) to <out>/probes.jsonl
  --no-screenshot               Disable the automatic proof screenshot (on by default)
  --list-ops                    Print the available ProbeOps and their form keys, then exit
  --no-preflight                Skip the DNS/TLS preflight
  --include-unconfirmed         Include PendingDelete (also needs --i-understand-mutations)
  -h, --help                    This text

Examples:
  bun run capture:f402 --dry-run
  bun run capture:f402 --suite manager-boot --dry-run
  bun run capture:f402 --login --suite manager-boot --promote-dir docs/evidence/captures
  bun run capture:f402 --login --ops getDailyFiguresByCustomer --prefix /cloud/api/Report
  bun run capture:f402 --login --sniff-requests --screenshot-format webp --screenshot-resize 1280x720

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

export type { SniffedFormTemplate };

/** Extract only form-field or JSON top-level keys (never values) from a POST body. */
export function extractFormKeys(postData: string | undefined): string[] {
  if (!postData || postData.trim() === "") return [];
  const trimmed = postData.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        return Object.keys(obj)
          .map((k) => k.trim())
          .filter(Boolean)
          .sort();
      }
    } catch {
      // Fall back to URLSearchParams.
    }
  }
  const keys = new Set<string>();
  for (const [key] of new URLSearchParams(postData)) {
    if (key.trim() !== "") keys.add(key.trim());
  }
  return [...keys].sort();
}

async function resolveAgentId(): Promise<string> {
  const fromEnv = process.env.F402_AGENT_ID?.trim() ?? "";
  if (fromEnv !== "") return fromEnv;
  try {
    return (
      (
        await Bun.secrets.get({
          service: SECRETS_SERVICE,
          name: SECRET_NAMES.agentId,
        })
      )?.trim() ?? ""
    );
  } catch {
    return "";
  }
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
  const backendRaw = flagValue(
    parsed,
    "--backend",
    process.platform === "darwin" ? "webkit" : "chrome",
  ).toLowerCase();
  const backend: "webkit" | "chrome" =
    backendRaw === "chrome" ? "chrome" : "webkit";
  const sniffRequests = hasFlag(parsed, "--sniff-requests");
  const forceJsonBody = hasFlag(parsed, "--json-body");
  const profile = flagValue(parsed, "--profile", "scratch/webview-profile");
  const outRoot = flagValue(parsed, "--out", "scratch/f402-probes");
  const promoteDir = flagValue(parsed, "--promote-dir", "");
  const fromProbesRaw = flagValue(parsed, "--from-probes", "");
  const screenshotFormatRaw = flagValue(
    parsed,
    "--screenshot-format",
    "",
  ).toLowerCase();
  const screenshotResizeRaw = flagValue(parsed, "--screenshot-resize", "");
  const screenshotQualityRaw = flagValue(parsed, "--screenshot-quality", "82");
  const jsonl = hasFlag(parsed, "--jsonl");
  const noScreenshot = hasFlag(parsed, "--no-screenshot");
  const autoScreenshot = !noScreenshot;
  const wantScreenshot =
    autoScreenshot ||
    hasFlag(parsed, "--screenshot") ||
    screenshotFormatRaw !== "" ||
    screenshotResizeRaw !== "";
  const screenshotFormat: ScreenshotFormat =
    screenshotFormatRaw === "png" || screenshotFormatRaw === "jpeg"
      ? screenshotFormatRaw
      : "webp";
  const screenshotQuality = Number.isFinite(Number(screenshotQualityRaw))
    ? Math.min(Math.max(Number(screenshotQualityRaw), 1), 100)
    : 82;
  const screenshotResize =
    screenshotResizeRaw === ""
      ? undefined
      : {
          ...parseResize(screenshotResizeRaw),
          fit: "inside" as const,
          withoutEnlargement: true,
        };

  const waitFor = flagValue(parsed, "--wait-for", "");
  const explicitBody = flagValue(parsed, "--body", "");
  const weekValue = flagValue(parsed, "--week", "");
  const weekSweepRaw = flagValue(parsed, "--week-sweep", "");
  const weekSweep =
    weekSweepRaw === "" ? 0 : Math.max(0, Number(weekSweepRaw) || 0);
  const ticketValue = flagValue(parsed, "--ticket", "");
  const wagerValue = flagValue(parsed, "--wager", "");
  const flagValue_ = flagValue(parsed, "--flag", "");
  const prefix = flagValue(parsed, "--prefix", PROBE_PREFIXES[0]!);
  const suiteRaw = flagValue(parsed, "--suite", "").toLowerCase();
  const opsArg = flagValue(parsed, "--ops", "");
  const loginWaitMs = Number(flagValue(parsed, "--login-wait-ms", "180000"));
  const autoLogin = hasFlag(parsed, "--login");
  const includeUnconfirmed = hasFlag(parsed, "--include-unconfirmed");
  const dryRun = hasFlag(parsed, "--dry-run");
  const listOps = hasFlag(parsed, "--list-ops");

  if (listOps) {
    for (const op of PROBE_OPS) {
      console.log(
        op.operation.padEnd(32),
        op.readOnly ? "read " : "MUT  ",
        op.params.join(","),
      );
    }
    return 0;
  }

  if (includeUnconfirmed && !hasFlag(parsed, "--i-understand-mutations")) {
    console.error(
      "capture:f402: --include-unconfirmed also needs --i-understand-mutations; PendingDelete is gated behind explicit opt-in",
    );
    return 2;
  }

  const suite: ProbeSuite =
    suiteRaw === "manager-boot" || suiteRaw === "all"
      ? suiteRaw
      : opsArg !== ""
        ? "all"
        : "report";

  const selected = selectProbeOps(includeUnconfirmed, suite);
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

  let agentId = await resolveAgentId();
  const contentTypeFor = (op: (typeof ops)[number]): ProbeWireContentType =>
    forceJsonBody
      ? "application/json"
      : (op.wireContentType ??
        "application/x-www-form-urlencoded; charset=UTF-8");

  // Pure: CLI flag values in, body options out. Shared by bodyFor and the week-sweep path
  // so the two can never diverge on which overrides exist.
  const probeBodyOpts = () => ({
    ...(ticketValue === "" ? {} : { ticketNumber: ticketValue }),
    ...(wagerValue === "" ? {} : { wagerNumber: wagerValue }),
    ...(flagValue_ === "" ? {} : { flag: flagValue_ }),
  });

  const bodyFor = (op: (typeof ops)[number]): string => {
    if (explicitBody !== "") return explicitBody;
    if (agentId === "") return "";
    const cid = process.env.F402_CUSTOMER_ID?.trim() || "__CUSTOMER_ID__";
    return contentTypeFor(op) === "application/json"
      ? buildJsonProbeBody(op, agentId, cid, probeBodyOpts())
      : buildProbeBody(op, agentId, cid, probeBodyOpts());
  };

  if (dryRun) {
    console.error(
      `capture:f402: plan for ${base} (${ops.length} operations, suite ${suite}, prefix ${prefix}, backend ${backend})`,
    );
    for (const op of ops) {
      const shown =
        agentId === ""
          ? bodyFor(op)
          : bodyFor(op).replaceAll(agentId, "<agent>");
      console.log(
        `${op.operation.padEnd(30)} ${op.method.padEnd(4)} ${probeUrl(base, op, prefix)}  contentType=${contentTypeFor(op)}  body=${shown}  ${op.readOnly ? "" : "[unconfirmed]"}`,
      );
    }
    console.error("capture:f402: dry run; nothing launched");
    return 0;
  }

  if (fromProbesRaw !== "") {
    if (promoteDir === "") {
      console.error("capture:f402: --from-probes requires --promote-dir <dir>");
      return 2;
    }
    const probePaths = fromProbesRaw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    const store = new CaptureStore({ root: promoteDir });
    const promotedOps: string[] = [];
    const promotedDates = new Set<string>();
    let latestRunTls: unknown = null;

    for (const probePath of probePaths) {
      const rawProbe = (await Bun.file(probePath).json()) as Record<
        string,
        unknown
      >;
      const result = parseProbePageResult(rawProbe["result"]);
      if (result.status < 200 || result.status > 299) {
        console.error(
          `capture:f402: refusing to promote non-2xx probe ${probePath} (status ${result.status})`,
        );
        return 1;
      }
      if (rawProbe["readOnlyConfirmed"] !== true) {
        console.error(
          `capture:f402: refusing to promote unconfirmed-mutation probe ${probePath}`,
        );
        return 1;
      }
      const probeUrlStr = String(rawProbe["url"] ?? "");
      const parsedUrl = new URL(probeUrlStr);
      const opPath = parsedUrl.pathname;
      const capturedAt = String(
        rawProbe["capturedAt"] ?? new Date().toISOString(),
      );
      const bodyStr = String(rawProbe["body"] ?? "");
      const reqContentType =
        typeof rawProbe["requestContentType"] === "string"
          ? rawProbe["requestContentType"]
          : bodyStr.trim().startsWith("{")
            ? "application/json"
            : "application/x-www-form-urlencoded; charset=UTF-8";
      let wireText = result.bodyText ?? result.preview;
      let truncatedPreview = false;
      if (
        result.bodyText === undefined &&
        result.contentType.toLowerCase().includes("json") &&
        result.bytes > result.preview.length
      ) {
        const firstObjEnd = result.preview.indexOf("},{");
        if (firstObjEnd !== -1) {
          wireText = `${result.preview.slice(0, firstObjEnd + 1)}]}`;
          truncatedPreview = true;
        }
      }

      const captureRecord = buildCaptureRecord({
        mode: "live",
        capturedAt,
        operation: {
          path: opPath,
          method: "POST",
        },
        request: {
          url: probeUrlStr,
          method: "POST",
          headers: {
            "content-type": reqContentType,
            "x-requested-with": "XMLHttpRequest",
            authorization: "Bearer <redacted>",
          },
          contentType: reqContentType,
          body: bodyStr,
        },
        response: {
          status: result.status,
          headers: { "content-type": result.contentType },
          contentType: result.contentType,
          bytes: new TextEncoder().encode(wireText),
          wireBytes: result.bytes,
          truncatedPreview,
        },
        provenance: {
          portalHost: parsedUrl.host,
          proxy: "none",
          auth: "cookie",
          bunVersion: Bun.version,
        },
        samples: 1,
      });
      await store.write(captureRecord);
      promotedOps.push(opPath);
      promotedDates.add(capturedAt.slice(0, 10));

      const siblingRunPath = join(
        probePath.split("/").slice(0, -1).join("/"),
        "run.json",
      );
      try {
        const siblingRun = (await Bun.file(siblingRunPath).json()) as Record<
          string,
          unknown
        >;
        if (siblingRun["tls"]) latestRunTls = siblingRun["tls"];
      } catch {
        // Ignore missing sibling run.json.
      }
    }

    await store.finalize();
    for (const dateDir of promotedDates) {
      const runPath = join(promoteDir, dateDir, "run.json");
      let existingOps: string[] = [];
      let existingTls: unknown = null;
      try {
        const prev = (await Bun.file(runPath).json()) as {
          ops?: readonly string[];
          tls?: unknown;
        };
        if (Array.isArray(prev.ops)) existingOps = [...prev.ops];
        if (prev.tls) existingTls = prev.tls;
      } catch {
        // First run.json for this date directory.
      }
      const mergedOps = [...new Set([...existingOps, ...promotedOps])].sort();
      await Bun.write(
        runPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            kind: "probe-run",
            startedAt: new Date().toISOString(),
            base,
            backend,
            authMode: "env-login",
            tls: latestRunTls ?? existingTls,
            ops: mergedOps,
          },
          null,
          2,
        )}\n`,
      );
    }
    console.error(
      `capture:f402: promoted ${promotedOps.length} 2xx capture(s) from probes into ${promoteDir}`,
    );
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

  let tls: Awaited<ReturnType<typeof preflight>>["tls"] = null;
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
    tls = check.tls;
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
  const cdpSniffed: SniffedFormTemplate[] = [];
  let unsubscribeSniffer: (() => void) | null = null;

  try {
    if (sniffRequests && backend === "chrome") {
      await view.cdp("Network.enable");
      unsubscribeSniffer = view.onCdpEvent<CdpRequestWillBeSent>(
        "Network.requestWillBeSent",
        (event) => {
          const reqUrl = event.request?.url ?? "";
          if (!reqUrl.includes("/cloud/api/")) return;
          try {
            const parsedUrl = new URL(reqUrl);
            cdpSniffed.push({
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

    let authMode: "env-login" | "selector" | "interactive";

    if (autoLogin) {
      const outcome = await loginF402(view, {
        baseUrl: base,
        timeoutMs: loginWaitMs,
        ...(sniffRequests
          ? { beforeSubmitExpression: buildInstallRequestSnifferExpression() }
          : {}),
      });
      if (agentId === "" && outcome.agentId !== "") {
        agentId = outcome.agentId;
      }
      authMode = "env-login";
      console.error(
        `capture:f402: signed in on ${backend} with F402_AGENT_ID / F402_PASSWORD`,
      );
      if (sniffRequests) {
        await view.evaluate(buildInstallRequestSnifferExpression());
      }
    } else {
      await view.navigate(base);
      await view.waitForLoad();
      if (sniffRequests) {
        await view.evaluate(buildInstallRequestSnifferExpression());
      }

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
      if (sniffRequests) {
        await view.evaluate(buildInstallRequestSnifferExpression());
      }
    }

    await mkdir(outDir, { recursive: true });
    await Bun.write(
      join(outDir, "run.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "probe-run",
          startedAt: new Date().toISOString(),
          base,
          suite,
          prefix,
          backend,
          authMode,
          tls,
          ops: ops.map((op) => op.operation),
        },
        null,
        2,
      )}\n`,
    );

    const promoteStore =
      promoteDir !== "" ? new CaptureStore({ root: promoteDir }) : null;
    let promotedCount = 0;
    const promotedOps: string[] = [];
    const promotedDates = new Set<string>();
    let transportErrors = 0;
    const portalHost = new URL(base).host;
    const jsonlLines: string[] = [];

    for (const op of ops) {
      const url = probeUrl(base, op, prefix);
      const reqContentType = contentTypeFor(op);
      const hasWeek = op.params.includes("week");
      const sweepValues =
        weekSweep > 0 && hasWeek
          ? Array.from({ length: weekSweep + 1 }, (_, i) => i)
          : [null];
      for (const weekIdx of sweepValues) {
        const effectiveWeekValue =
          weekIdx === null ? weekValue : String(weekIdx);
        const body =
          weekIdx === null || explicitBody !== ""
            ? bodyFor(op)
            : buildProbeBody(
                op,
                agentId,
                process.env.F402_CUSTOMER_ID?.trim() || "__CUSTOMER_ID__",
                probeBodyOpts(),
              );
        const outFile =
          weekIdx === null
            ? `${op.operation}.json`
            : `${op.operation}.week${weekIdx}.json`;
        try {
          const raw = await view.evaluate(
            buildProbeExpression(
              {
                operation: op.operation,
                url,
                body,
                contentType: reqContentType,
              },
              2_000,
              effectiveWeekValue === "" ? undefined : effectiveWeekValue,
            ),
          );
          const result = parseProbePageResult(raw);
          const { bodyText, ...scratchResult } = result;
          const capturedAt = new Date().toISOString();
          const record = {
            schemaVersion: 1,
            kind: "webview-probe",
            backend,
            capturedAt,
            operation: op.operation,
            url,
            method: op.method,
            requestContentType: reqContentType,
            body,
            dateUsed: result.dateUsed ?? null,
            weekUsed: result.weekUsed ?? null,
            authMode,
            readOnlyConfirmed: op.readOnly,
            headersObserved: false,
            result: scratchResult,
            extractedText: scratchResult.contentType.includes("text/html")
              ? htmlToText(scratchResult.preview).slice(0, 2_000)
              : null,
            note: op.note,
          };
          await Bun.write(
            join(outDir, outFile),
            `${JSON.stringify(record, null, 2)}\n`,
          );
          if (jsonl) jsonlLines.push(JSON.stringify(record));

          if (
            promoteStore !== null &&
            op.readOnly &&
            result.status >= 200 &&
            result.status <= 299
          ) {
            const opPath = `${prefix.replace(/\/$/, "")}/${op.operation}`;
            const wireText = bodyText ?? result.preview;
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
                  "content-type": reqContentType,
                  "x-requested-with": "XMLHttpRequest",
                  authorization: "Bearer <redacted>",
                },
                contentType: reqContentType,
                body,
              },
              response: {
                status: result.status,
                headers: { "content-type": result.contentType },
                contentType: result.contentType,
                bytes: new TextEncoder().encode(wireText),
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
            promotedOps.push(opPath);
            promotedDates.add(capturedAt.slice(0, 10));
          }

          const summary = probeSummary(op, result);
          console.log(
            `${summary.operation.padEnd(30)} ${String(summary.status).padEnd(5)} ${summary.verdict.padEnd(8)} ${summary.bytes} B`,
          );
        } catch (error) {
          transportErrors += 1;
          console.error(
            `${op.operation} (week=${weekIdx ?? "default"}): ${(error as Error).message}`,
          );
        }
      } // end week sweep
    }

    if (jsonl && jsonlLines.length > 0) {
      await Bun.write(
        join(outDir, "probes.jsonl"),
        `${jsonlLines.join("\n")}\n`,
      );
      console.error(
        `capture:f402: wrote ${jsonlLines.length} JSONL row(s) -> ${join(outDir, "probes.jsonl")}`,
      );
    }

    if (wantScreenshot) {
      const ext = screenshotFormat === "jpeg" ? "jpg" : screenshotFormat;
      const shotPath = join(outDir, `_page.${ext}`);
      const shot = await view.screenshotToFile(
        shotPath,
        screenshotFormat === "png"
          ? {
              format: "png",
              ...(screenshotResize === undefined
                ? {}
                : { resize: screenshotResize }),
            }
          : {
              format: screenshotFormat,
              quality: screenshotQuality,
              ...(screenshotResize === undefined
                ? {}
                : { resize: screenshotResize }),
            },
      );
      console.error(
        `capture:f402: saved ${screenshotFormat} proof screenshot (${shot.bytes} B, sha256 ${shot.sha256.slice(0, 12)}…) -> ${shot.path}`,
      );
    }

    if (promoteStore !== null && promotedCount > 0) {
      await promoteStore.finalize();
      for (const dateDir of promotedDates) {
        const runPath = join(promoteDir, dateDir, "run.json");
        let existingOps: string[] = [];
        try {
          const prev = (await Bun.file(runPath).json()) as {
            ops?: readonly string[];
          };
          if (Array.isArray(prev.ops)) existingOps = [...prev.ops];
        } catch {
          // First run.json for this date directory.
        }
        const mergedOps = [...new Set([...existingOps, ...promotedOps])].sort();
        await Bun.write(
          runPath,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              kind: "probe-run",
              startedAt: new Date().toISOString(),
              base,
              suite,
              prefix,
              backend,
              authMode,
              tls,
              ops: mergedOps,
            },
            null,
            2,
          )}\n`,
        );
      }
      console.error(
        `capture:f402: promoted ${promotedCount} 2xx capture(s) into ${promoteDir}`,
      );
    }

    if (sniffRequests) {
      const inPageRaw = await view
        .evaluate(buildReadRequestSnifferExpression())
        .catch(() => []);
      const combined = parseSniffedTemplates([
        ...(Array.isArray(inPageRaw) ? inPageRaw : []),
        ...cdpSniffed,
      ]);
      if (combined.length > 0) {
        await Bun.write(
          join(outDir, "_sniffed_form_templates.json"),
          `${JSON.stringify(combined, null, 2)}\n`,
        );
        console.error(
          `capture:f402: recorded ${combined.length} request template(s) on ${backend}`,
        );
      }
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
