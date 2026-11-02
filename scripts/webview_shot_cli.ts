#!/usr/bin/env bun
/**
 * @file scripts/webview_shot_cli.ts
 * @description Bun.WebView screenshot tool with an optional F402 login flow and Blob/Base64/Shmem modes.
 *
 * Usage:
 *   ./bin/dx shot <url> [--out scratch/shots/page.png] [--backend webkit|chrome]
 *   ./bin/dx shot <url> --encoding base64 --format webp
 *   ./bin/dx shot <url> --encoding shmem --kitty
 *   F402_LIVE_LOGIN=1 ./bin/dx shot --f402-login --f402-page /manager.html --out scratch/shots/f402.png
 *   ./bin/dx shot --profile scratch/webview-profile --f402-page /manager.html
 *
 * The login path never prints credentials; it reuses the evidence-capture WebView wrapper and the
 * same selectors as the capture tool.
 */

import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  formatKittyDirectEscape,
  kittyTransmission,
  parseResize,
  type ScreenshotEncoding,
} from "../lib/screenshot_encode.ts";
import { ManagedWebView, WebViewError } from "./capture/webview.ts";
import {
  captureShotFile,
  checkProfile,
  defaultShotPath,
  describeShotError,
  openShotView,
  screenshotOptions,
  withView,
  type ShotBackend,
  type ShotFileResult,
  type ShotFormat,
} from "./capture/shot.ts";

const RAW_HELP = `Bun.WebView screenshot tool

Usage:
  bun run scripts/webview_shot_cli.ts <url> [options]
  F402_LIVE_LOGIN=1 bun run scripts/webview_shot_cli.ts --f402-login [--f402-page /manager.html]
  bun run scripts/webview_shot_cli.ts --profile <dir> [--f402-page /manager.html]

Options:
  --out <path>            Output file or file:// URL (default scratch/shots/webview-<uuidv7>.<ext>)
  --width <px>            Viewport width (default 1440)
  --height <px>           Viewport height (default 900)
  --backend <name>        webkit (macOS default/zero deps) or chrome
  --format <name>         png | jpeg | webp (webp is re-encoded via Bun.Image on webkit)
  --encoding <name>       blob (default, mmap-backed on webkit) | buffer | base64 | shmem
  --kitty                 Show the screenshot inline in a Kitty-protocol terminal (PNG only). Uses
                          shared memory (t=s) locally, and direct transmission (t=d) on Windows or
                          over SSH, where the terminal cannot read this machine's shared memory
  --kitty-direct          --kitty, always with direct transmission
  --resize <WxH|W>        Resize with Bun.Image after capture
  --quality <1-100>       jpeg/webp quality (default 82)
  --wait-selector <css>   Wait for this selector before the screenshot
  --wait-ms <ms>          Extra settle delay (default 250)
  --timeout-ms <ms>       Navigation/selector timeout (default 20000)
  --f402-login            Log in with F402_AGENT_ID / F402_PASSWORD before capturing
  --f402-page <path>      Navigate to this path after login (default /)
  --profile <dir>         Reuse an existing WebView dataStore (path or file:// URL). With no URL it
                          opens --f402-page on the portal; output adds signedOutMarkers
                          (login-form, session-expired; empty = neither seen)
  --thumb <px>            Also write a WebP thumbnail (fits in px x px) next to the screenshot
  --placeholder           Include the ThumbHash data: URL of the screenshot
  --console               Include the page console (redacted, at most 200 lines)
  --cookies               Chrome only: the portal's cookies as name, domain, path, expiry and
                          flags. Values are never printed
  --retries <0-5>         Retry a failed navigation, waiting 500ms x attempt (default 0)
  --json                  JSON even on a terminal (pipes always get JSON)
  -h, --help

On a terminal the file result prints as a Bun.inspect.table; --json, a pipe, or --encoding
base64/buffer/shmem prints JSON.

Login is opt-in: it requires F402_LIVE_LOGIN=1 plus the credential env vars. A screenshot of a public
page does not require login. --profile only reads a profile's cookies; it never signs in by itself.
Chrome and WebKit keep separate cookie stores in the same directory, so --backend must match the
backend that signed in.`;

const HELP =
  process.stdout.columns === undefined
    ? RAW_HELP
    : Bun.wrapAnsi(RAW_HELP, process.stdout.columns, { wordWrap: true });

interface Options {
  url: string | null;
  out: string | null;
  width: number;
  height: number;
  backend: ShotBackend;
  format: ShotFormat;
  encoding: ScreenshotEncoding;
  kitty: boolean;
  kittyDirect: boolean;
  quality: number;
  resize: { width: number; height?: number } | null;
  waitSelector: string | null;
  waitMs: number;
  timeoutMs: number;
  f402Login: boolean;
  f402Page: string;
  profile: string | null;
  /** `undefined` = the flag's value was out of range. */
  thumb: number | null | undefined;
  placeholder: boolean;
  console: boolean;
  cookies: boolean;
  retries: number | undefined;
  json: boolean;
}

/** A path or a `file://` URL, as a filesystem path. */
export function toFsPath(raw: string): string {
  return raw.startsWith("file:") ? Bun.fileURLToPath(raw) : raw;
}

/** An integer in [min, max]; `undefined` when the flag was given out of range or not a number. */
export function boundedInt(
  raw: string,
  min: number,
  max: number,
): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

const SHOT_ARG_OPTIONS = {
  out: { type: "string" },
  width: { type: "string" },
  height: { type: "string" },
  backend: { type: "string" },
  format: { type: "string" },
  encoding: { type: "string" },
  kitty: { type: "boolean" },
  "kitty-direct": { type: "boolean" },
  resize: { type: "string" },
  quality: { type: "string" },
  "wait-selector": { type: "string" },
  "wait-ms": { type: "string" },
  "timeout-ms": { type: "string" },
  "f402-login": { type: "boolean" },
  "f402-page": { type: "string" },
  profile: { type: "string" },
  thumb: { type: "string" },
  placeholder: { type: "boolean" },
  console: { type: "boolean" },
  cookies: { type: "boolean" },
  retries: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** An argv the parser rejected: an unknown flag, a flag without its value, or a second URL. */
export class ShotUsageError extends Error {
  override readonly name = "ShotUsageError";
}

/** Throws {@link ShotUsageError}; `null` means --help. */
export function parseShotArgs(argv: readonly string[]): Options | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: SHOT_ARG_OPTIONS,
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new ShotUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const { values, positionals } = parsed;
  if (values.help === true) return null;
  if (positionals.length > 1) {
    throw new ShotUsageError(
      `expected at most one URL, got ${positionals.length}: ${positionals.join(" ")}`,
    );
  }
  const url = positionals[0] ?? null;

  const formatRaw = (values.format ?? "png").toLowerCase();
  const format: Options["format"] =
    formatRaw === "jpeg" || formatRaw === "webp" ? formatRaw : "png";
  const kittyDirect = values["kitty-direct"] === true;
  const kitty = kittyDirect || values.kitty === true;
  const encodingRaw = (
    values.encoding ?? (kitty ? "shmem" : "blob")
  ).toLowerCase();
  const encoding: ScreenshotEncoding =
    encodingRaw === "buffer" ||
    encodingRaw === "base64" ||
    encodingRaw === "shmem"
      ? encodingRaw
      : "blob";
  const backendRaw =
    values.backend ?? (process.platform === "darwin" ? "webkit" : "chrome");
  // webp no longer forces Chrome: Bun.Image re-encodes the PNG on webkit.
  const backend: Options["backend"] =
    backendRaw === "chrome" ? "chrome" : "webkit";
  const resizeRaw = values.resize ?? "";
  const thumbRaw = values.thumb ?? "";

  const width = Number(values.width ?? "1440");
  const height = Number(values.height ?? "900");
  const quality = Number(values.quality ?? "82");
  const waitMs = Number(values["wait-ms"] ?? "250");
  const timeoutMs = Number(values["timeout-ms"] ?? "20000");

  return {
    url,
    out: toFsPathOrNull(values.out ?? ""),
    width: Number.isFinite(width)
      ? Math.min(Math.max(width, 320), 16384)
      : 1440,
    height: Number.isFinite(height)
      ? Math.min(Math.max(height, 240), 16384)
      : 900,
    backend,
    format,
    encoding,
    kitty,
    kittyDirect,
    quality: Number.isFinite(quality)
      ? Math.min(Math.max(quality, 1), 100)
      : 82,
    resize: resizeRaw === "" ? null : parseResize(resizeRaw),
    waitSelector: values["wait-selector"] || null,
    waitMs: Number.isFinite(waitMs) ? Math.max(0, waitMs) : 250,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, timeoutMs) : 20_000,
    f402Login: values["f402-login"] === true,
    f402Page: values["f402-page"] ?? "/",
    profile: toFsPathOrNull(values.profile ?? ""),
    thumb: thumbRaw === "" ? null : boundedInt(thumbRaw, 16, 2048),
    placeholder: values.placeholder === true,
    console: values.console === true,
    cookies: values.cookies === true,
    retries: boundedInt(values.retries ?? "0", 0, 5),
    json: values.json === true,
  };
}

function toFsPathOrNull(raw: string): string | null {
  return raw === "" ? null : toFsPath(raw);
}

export async function runWebviewShot(argv: readonly string[]): Promise<void> {
  let options: Options | null;
  try {
    options = parseShotArgs(argv);
  } catch (error) {
    if (!(error instanceof ShotUsageError)) throw error;
    console.error(`webview-shot: ${error.message}\n`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  if (options === null) {
    console.log(HELP);
    return;
  }
  if (options.url !== null && !/^https?:\/\//.test(options.url)) {
    console.error("webview-shot: the URL must be http(s)\n");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (options.url === null && !options.f402Login && options.profile === null) {
    console.error(
      "webview-shot: provide an http(s) URL, --f402-login or --profile\n",
    );
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (options.profile !== null && !isDirectory(options.profile)) {
    console.error(
      `webview-shot: --profile ${options.profile} is not a directory; a WebView would start an empty, signed-out profile there`,
    );
    process.exitCode = 2;
    return;
  }
  if (options.thumb === undefined) {
    console.error("webview-shot: --thumb must be an integer from 16 to 2048");
    process.exitCode = 2;
    return;
  }
  if (options.retries === undefined) {
    console.error("webview-shot: --retries must be an integer from 0 to 5");
    process.exitCode = 2;
    return;
  }
  if (options.cookies && options.backend !== "chrome") {
    console.error(
      "webview-shot: --cookies reads cookies over CDP, which only --backend chrome has",
    );
    process.exitCode = 2;
    return;
  }
  if (options.encoding === "shmem" && options.format !== "png") {
    console.error(
      `webview-shot: --encoding shmem captures a PNG shared-memory segment, so --format ${options.format} has no effect.`,
    );
    console.error(
      "  Pass --format png (the default) or use --encoding blob/base64 for another format.",
    );
    process.exitCode = 2;
    return;
  }
  const request: ValidOptions = {
    ...options,
    thumb: options.thumb,
    retries: options.retries,
  };
  await withView(
    () => openShotView(request),
    (view) => emitShot(view, request),
  );
}

type ValidOptions = Omit<Options, "thumb" | "retries"> & {
  readonly thumb: number | null;
  readonly retries: number;
};

async function emitShot(
  view: ManagedWebView,
  options: ValidOptions,
): Promise<void> {
  if (options.encoding === "shmem") {
    if (
      options.kitty &&
      (options.kittyDirect ||
        kittyTransmission(process.platform, process.env) === "direct")
    ) {
      const png = await view.screenshotBase64({ format: "png" });
      process.stdout.write(formatKittyDirectEscape(png.base64));
      return;
    }
    const shmem = await view.screenshotShmem();
    if (options.kitty) {
      process.stdout.write(shmem.kittyEscape);
    } else {
      console.log(JSON.stringify(shmem, null, 2));
    }
    return;
  }

  if (options.encoding === "base64") {
    const profileCheck = await checkProfile(view, options.profile);
    const b64 = await view.screenshotBase64(screenshotOptions(options));
    console.log(
      JSON.stringify(
        {
          encoding: "base64",
          mimeType: b64.mimeType,
          dataUri: b64.dataUri,
          backend: options.backend,
          format: options.format,
          ...profileCheck,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (options.encoding === "buffer") {
    const profileCheck = await checkProfile(view, options.profile);
    const blob = await view.screenshotBlob(screenshotOptions(options));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    console.log(
      JSON.stringify(
        {
          encoding: "buffer",
          mimeType: blob.type,
          bytes: bytes.byteLength,
          base64: Buffer.from(bytes).toString("base64"),
          ...profileCheck,
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await captureShotFile(view, {
    ...options,
    out: options.out ?? defaultShotPath(options.format),
  });
  console.log(
    options.json || process.stdout.isTTY !== true
      ? JSON.stringify(result, null, 2)
      : renderShotTable(result, process.stdout.isTTY === true),
  );
}

/** One row per field: a screenshot result is one record, and a wide single row wraps badly. */
export function renderShotTable(
  result: ShotFileResult,
  colors: boolean,
): string {
  const rows: { field: string; value: string }[] = [
    { field: "screenshot", value: result.screenshot },
    { field: "screenshotUrl", value: result.screenshotUrl },
    { field: "bytes", value: String(result.bytes) },
    { field: "sha256", value: result.sha256 },
    { field: "backend", value: `${result.backend} (${result.format})` },
    { field: "title", value: result.title },
    { field: "url", value: result.url },
  ];
  if (result.signedOutMarkers !== undefined) {
    rows.push({
      field: "signedOutMarkers",
      value:
        result.signedOutMarkers.length === 0
          ? "none seen"
          : result.signedOutMarkers.join(", "),
    });
  }
  if (result.thumb !== undefined)
    rows.push({ field: "thumb", value: result.thumb });
  if (result.placeholder !== undefined) {
    rows.push({
      field: "placeholder",
      value: `data: URL, ${result.placeholder.length} chars (--json prints it)`,
    });
  }
  if (result.console !== undefined) {
    rows.push({
      field: "console",
      value: `${result.console.length} line(s) (--json prints them)`,
    });
  }
  if (result.cookies !== undefined) {
    const expired = result.cookies.filter((cookie) => cookie.expired).length;
    rows.push({
      field: "cookies",
      value:
        result.cookies.length === 0
          ? "no portal cookies"
          : `${result.cookies.length} portal (${expired} expired): ${result.cookies.map((cookie) => cookie.name).join(", ")}`,
    });
  }
  return Bun.inspect.table(
    Object.fromEntries(rows.map(({ field, value }) => [field, { value }])),
    ["value"],
    { colors },
  );
}

if (import.meta.main) {
  runWebviewShot(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `webview-shot: ${
        error instanceof WebViewError
          ? describeShotError(error)
          : error instanceof Error
            ? error.message
            : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
