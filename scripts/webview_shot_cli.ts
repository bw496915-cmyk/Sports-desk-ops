#!/usr/bin/env bun
/**
 * @file scripts/webview_shot_cli.ts
 * @description Bun.WebView screenshot tool with an optional F402 login flow.
 *
 * Usage:
 *   ./bin/dx shot <url> [--out scratch/shots/page.png] [--backend webkit|chrome]
 *   F402_LIVE_LOGIN=1 ./bin/dx shot --f402-login --f402-page /manager --out scratch/shots/f402.png
 *
 * The login path never prints credentials; it reuses the evidence-capture WebView wrapper and the
 * same selectors as the capture tool.
 */

import { join } from "node:path";
import { ManagedWebView } from "./capture/webview.ts";
import { loginF402 } from "./capture/f402_login.ts";

const HELP = `Bun.WebView screenshot tool

Usage:
  bun run scripts/webview_shot_cli.ts <url> [options]
  F402_LIVE_LOGIN=1 bun run scripts/webview_shot_cli.ts --f402-login [--f402-page /manager]

Options:
  --out <path>            Output file (default scratch/shots/webview-<epoch>.<ext>)
  --width <px>            Viewport width (default 1440)
  --height <px>           Viewport height (default 900)
  --backend <name>        webkit (macOS default/zero deps) or chrome
  --format <name>         png | jpeg | webp (webp requires chrome)
  --quality <1-100>       jpeg/webp quality (default 82)
  --wait-selector <css>   Wait for this selector before the screenshot
  --wait-ms <ms>          Extra settle delay (default 250)
  --timeout-ms <ms>       Navigation/selector timeout (default 20000)
  --f402-login            Log in with F402_AGENT_ID / F402_PASSWORD before capturing
  --f402-page <path>      Navigate to this path after login (default /)
  -h, --help

Login is opt-in: it requires F402_LIVE_LOGIN=1 plus the credential env vars. A screenshot of a public
page does not require login.`;

interface Options {
  url: string | null;
  out: string | null;
  width: number;
  height: number;
  backend: "webkit" | "chrome";
  format: "png" | "jpeg" | "webp";
  quality: number;
  waitSelector: string | null;
  waitMs: number;
  timeoutMs: number;
  f402Login: boolean;
  f402Page: string;
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
    "--quality",
    "--wait-selector",
    "--wait-ms",
    "--timeout-ms",
    "--f402-page",
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
  const backendRaw = flag(
    args,
    ["--backend"],
    process.platform === "darwin" ? "webkit" : "chrome",
  );
  const backend: Options["backend"] =
    backendRaw === "chrome" || format === "webp" ? "chrome" : "webkit";

  const width = Number(flag(args, ["--width"], "1440"));
  const height = Number(flag(args, ["--height"], "900"));
  const quality = Number(flag(args, ["--quality"], "82"));
  const waitMs = Number(flag(args, ["--wait-ms"], "250"));
  const timeoutMs = Number(flag(args, ["--timeout-ms"], "20000"));

  return {
    url,
    out: flag(args, ["--out"], "") || null,
    width: Number.isFinite(width)
      ? Math.min(Math.max(width, 320), 16384)
      : 1440,
    height: Number.isFinite(height)
      ? Math.min(Math.max(height, 240), 16384)
      : 900,
    backend,
    format,
    quality: Number.isFinite(quality)
      ? Math.min(Math.max(quality, 1), 100)
      : 82,
    waitSelector: flag(args, ["--wait-selector"], "") || null,
    waitMs: Number.isFinite(waitMs) ? Math.max(0, waitMs) : 250,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, timeoutMs) : 20_000,
    f402Login: args.includes("--f402-login"),
    f402Page: flag(args, ["--f402-page"], "/"),
  };
}

export const DEFAULT_SHOT_DIR = "scratch/shots";

export async function runWebviewShot(argv: readonly string[]): Promise<void> {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return;
  }
  const options = parseArgs(args);
  if (
    !options.f402Login &&
    (options.url === null || !/^https?:\/\//.test(options.url))
  ) {
    console.error("webview-shot: provide an http(s) URL or --f402-login\n");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  const extension = options.format === "jpeg" ? "jpg" : options.format;
  const out =
    options.out ?? join(DEFAULT_SHOT_DIR, `webview-${Date.now()}.${extension}`);

  const view = ManagedWebView.launch({
    backend: options.backend,
    width: options.width,
    height: options.height,
    navigateTimeoutMs: options.timeoutMs,
  });

  try {
    if (options.f402Login) {
      if (process.env.F402_LIVE_LOGIN?.trim() !== "1") {
        throw new Error("F402 login is opt-in: set F402_LIVE_LOGIN=1");
      }
      await loginF402(view, { timeoutMs: options.timeoutMs });
      const baseUrl = (
        process.env.F402_BASE_URL?.trim() || "https://www.fantasy402.com"
      ).replace(/\/$/, "");
      const suffix = options.f402Page.startsWith("/")
        ? options.f402Page
        : `/${options.f402Page}`;
      await view.navigate(`${baseUrl}${suffix}`, {
        timeoutMs: options.timeoutMs,
      });
    } else {
      await view.navigate(options.url!, { timeoutMs: options.timeoutMs });
    }

    if (options.waitSelector !== null) {
      await view.waitForSelector(options.waitSelector, {
        timeoutMs: options.timeoutMs,
      });
    }
    if (options.waitMs > 0) await Bun.sleep(options.waitMs);

    const screenshot = await view.screenshotToFile(
      out,
      options.format === "png"
        ? { format: "png" }
        : { format: options.format, quality: options.quality },
    );
    const title = String((await view.evaluate("document.title")) ?? "");
    const url = String((await view.evaluate("location.href")) ?? "");
    console.log(
      JSON.stringify(
        {
          screenshot: screenshot.path,
          bytes: screenshot.bytes,
          sha256: screenshot.sha256,
          backend: options.backend,
          format: options.format,
          title,
          url,
        },
        null,
        2,
      ),
    );
  } finally {
    await view.close();
  }
}

if (import.meta.main) {
  runWebviewShot(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `webview-shot: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
