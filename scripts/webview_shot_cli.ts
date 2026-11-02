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
import { join } from "node:path";
import {
  ManagedWebView,
  WebViewError,
  type ConsoleLine,
} from "./capture/webview.ts";
import {
  parseResize,
  type ScreenshotEncoding,
} from "../lib/screenshot_encode.ts";
import {
  describeCookiesForHost,
  type CookieMetadata,
} from "./capture/cookies.ts";
import { loginF402 } from "./capture/f402_login.ts";
import { hostOf } from "./capture/ops.ts";

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
  --kitty                 Write Kitty graphics protocol t=s escape sequence (implies --encoding shmem)
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
  backend: "webkit" | "chrome";
  format: "png" | "jpeg" | "webp";
  encoding: ScreenshotEncoding;
  kitty: boolean;
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

/**
 * What a signed-out portal shows: the login form at `/`, and a "Your session has expired" dialog on
 * `/manager.html` (both seen 2026-11-02 with an empty WebKit profile).
 */
export type SignedOutMarker = "login-form" | "session-expired";

/** Present only with --profile: what the page showed, not a claim that the session is valid. */
interface ProfileCheck {
  readonly profile: string;
  readonly signedOutMarkers: readonly SignedOutMarker[];
}

const SIGNED_OUT_MARKERS = `(() => {
  const markers = [];
  if (document.querySelector("input[type=password]") !== null) markers.push("login-form");
  if (/session has expired/i.test(document.body?.innerText ?? "")) markers.push("session-expired");
  return markers;
})()`;

export function parseSignedOutMarkers(value: unknown): SignedOutMarker[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (marker): marker is SignedOutMarker =>
      marker === "login-form" || marker === "session-expired",
  );
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

const RETRY_BACKOFF_MS = 500;

function isRetryable(error: unknown): boolean {
  return (
    error instanceof WebViewError &&
    (error.code === "navigate-failed" || error.code === "load-timeout")
  );
}

/** Retries only navigation failures and load timeouts; returns the number of attempts made. */
export async function navigateWithRetry(
  view: Pick<ManagedWebView, "navigate">,
  url: string,
  options: {
    readonly timeoutMs: number;
    readonly retries: number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<number> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await view.navigate(url, { timeoutMs: options.timeoutMs });
      return attempt + 1;
    } catch (error) {
      if (attempt >= options.retries || !isRetryable(error)) throw error;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function f402BaseUrl(): string {
  return (
    process.env.F402_BASE_URL?.trim() || "https://www.fantasy402.com"
  ).replace(/\/$/, "");
}

function f402Url(page: string): string {
  return `${f402BaseUrl()}${page.startsWith("/") ? page : `/${page}`}`;
}

function flag(
  args: readonly string[],
  names: readonly string[],
  fallback: string,
): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1]!;
  }
  return fallback;
}

function parseArgs(args: readonly string[]): Options {
  const flagValues = new Set([
    "--out",
    "--width",
    "--height",
    "--backend",
    "--format",
    "--encoding",
    "--resize",
    "--quality",
    "--wait-selector",
    "--wait-ms",
    "--timeout-ms",
    "--f402-page",
    "--profile",
    "--thumb",
    "--retries",
  ]);
  let url: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (flagValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    url = arg;
    break;
  }

  const formatRaw = flag(args, ["--format"], "png").toLowerCase();
  const format: Options["format"] =
    formatRaw === "jpeg" || formatRaw === "webp" ? formatRaw : "png";
  const kitty = args.includes("--kitty");
  const encodingRaw = flag(
    args,
    ["--encoding"],
    kitty ? "shmem" : "blob",
  ).toLowerCase();
  const encoding: ScreenshotEncoding =
    encodingRaw === "buffer" ||
    encodingRaw === "base64" ||
    encodingRaw === "shmem"
      ? encodingRaw
      : "blob";
  const backendRaw = flag(
    args,
    ["--backend"],
    process.platform === "darwin" ? "webkit" : "chrome",
  );
  // webp no longer forces Chrome: Bun.Image re-encodes the PNG on webkit.
  const backend: Options["backend"] =
    backendRaw === "chrome" ? "chrome" : "webkit";
  const resizeRaw = flag(args, ["--resize"], "");
  const thumbRaw = flag(args, ["--thumb"], "");

  const width = Number(flag(args, ["--width"], "1440"));
  const height = Number(flag(args, ["--height"], "900"));
  const quality = Number(flag(args, ["--quality"], "82"));
  const waitMs = Number(flag(args, ["--wait-ms"], "250"));
  const timeoutMs = Number(flag(args, ["--timeout-ms"], "20000"));

  return {
    url,
    out: toFsPathOrNull(flag(args, ["--out"], "")),
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
    quality: Number.isFinite(quality)
      ? Math.min(Math.max(quality, 1), 100)
      : 82,
    resize: resizeRaw === "" ? null : parseResize(resizeRaw),
    waitSelector: flag(args, ["--wait-selector"], "") || null,
    waitMs: Number.isFinite(waitMs) ? Math.max(0, waitMs) : 250,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, timeoutMs) : 20_000,
    f402Login: args.includes("--f402-login"),
    f402Page: flag(args, ["--f402-page"], "/"),
    profile: toFsPathOrNull(flag(args, ["--profile"], "")),
    thumb: thumbRaw === "" ? null : boundedInt(thumbRaw, 16, 2048),
    placeholder: args.includes("--placeholder"),
    console: args.includes("--console"),
    cookies: args.includes("--cookies"),
    retries: boundedInt(flag(args, ["--retries"], "0"), 0, 5),
    json: args.includes("--json"),
  };
}

function toFsPathOrNull(raw: string): string | null {
  return raw === "" ? null : toFsPath(raw);
}

export const DEFAULT_SHOT_DIR = "scratch/shots";

export async function runWebviewShot(argv: readonly string[]): Promise<void> {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return;
  }
  const options = parseArgs(args);
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
  const { thumb, retries } = options;

  const extension = options.format === "jpeg" ? "jpg" : options.format;
  const out =
    options.out ??
    join(DEFAULT_SHOT_DIR, `webview-${Bun.randomUUIDv7()}.${extension}`);

  await using view = ManagedWebView.launch({
    backend: options.backend,
    width: options.width,
    height: options.height,
    navigateTimeoutMs: options.timeoutMs,
    ...(options.profile === null ? {} : { dataStoreDir: options.profile }),
  });

  if (options.f402Login) {
    if (process.env.F402_LIVE_LOGIN?.trim() !== "1") {
      throw new Error("F402 login is opt-in: set F402_LIVE_LOGIN=1");
    }
    await loginF402(view, { timeoutMs: options.timeoutMs });
    await navigateWithRetry(view, f402Url(options.f402Page), {
      timeoutMs: options.timeoutMs,
      retries,
    });
  } else {
    await navigateWithRetry(view, options.url ?? f402Url(options.f402Page), {
      timeoutMs: options.timeoutMs,
      retries,
    });
  }

  if (options.waitSelector !== null) {
    await view.waitForSelector(options.waitSelector, {
      timeoutMs: options.timeoutMs,
    });
  }
  if (options.waitMs > 0) await Bun.sleep(options.waitMs);

  const profileCheck: ProfileCheck | null =
    options.profile === null
      ? null
      : {
          profile: options.profile,
          signedOutMarkers: parseSignedOutMarkers(
            await view.evaluate(SIGNED_OUT_MARKERS),
          ),
        };

  const shotOptions =
    options.format === "png"
      ? {
          format: "png" as const,
          ...(options.resize === null ? {} : { resize: options.resize }),
        }
      : {
          format: options.format,
          quality: options.quality,
          ...(options.resize === null ? {} : { resize: options.resize }),
        };

  if (options.encoding === "shmem") {
    if (options.format !== "png") {
      console.error(
        `webview-shot: --encoding shmem captures a PNG shared-memory segment, so --format ${options.format} has no effect.`,
      );
      console.error(
        "  Pass --format png (the default) or use --encoding blob/base64 for another format.",
      );
      process.exitCode = 2;
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
    const b64 = await view.screenshotBase64(shotOptions);
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
    const blob = await view.screenshotBlob(shotOptions);
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

  const screenshot = await view.screenshotToFile(out, shotOptions);
  const thumbPath =
    thumb === null ? null : await writeThumb(screenshot.path, thumb);
  const result: ShotFileResult = {
    screenshot: screenshot.path,
    bytes: screenshot.bytes,
    sha256: screenshot.sha256,
    mimeType: screenshot.mimeType,
    backend: options.backend,
    format: options.format,
    encoding: options.encoding,
    title: String((await view.evaluate("document.title")) ?? ""),
    url: String((await view.evaluate("location.href")) ?? ""),
    ...profileCheck,
    ...(thumbPath === null ? {} : { thumb: thumbPath }),
    ...(options.placeholder && screenshot.placeholder !== undefined
      ? { placeholder: screenshot.placeholder }
      : {}),
    ...(options.console ? { console: view.consoleLog } : {}),
    ...(options.cookies
      ? {
          cookies: describeCookiesForHost(
            await view.getAllCookies(),
            hostOf(f402BaseUrl()),
          ),
        }
      : {}),
  };
  console.log(
    options.json || process.stdout.isTTY !== true
      ? JSON.stringify(result, null, 2)
      : renderShotTable(result, process.stdout.isTTY === true),
  );
}

interface ShotFileResult extends Partial<ProfileCheck> {
  readonly screenshot: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mimeType: string;
  readonly backend: Options["backend"];
  readonly format: Options["format"];
  readonly encoding: ScreenshotEncoding;
  readonly title: string;
  readonly url: string;
  readonly thumb?: string;
  readonly placeholder?: string;
  readonly console?: readonly ConsoleLine[];
  readonly cookies?: readonly CookieMetadata[];
}

/** One row per field: a screenshot result is one record, and a wide single row wraps badly. */
export function renderShotTable(
  result: ShotFileResult,
  colors: boolean,
): string {
  const rows: { field: string; value: string }[] = [
    { field: "screenshot", value: result.screenshot },
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

async function writeThumb(screenshotPath: string, px: number): Promise<string> {
  const thumbPath = `${screenshotPath.replace(/\.[^./]+$/, "")}.thumb.webp`;
  await new Bun.Image(Bun.file(screenshotPath))
    .resize(px, px, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .write(thumbPath);
  return thumbPath;
}

if (import.meta.main) {
  runWebviewShot(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `webview-shot: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
