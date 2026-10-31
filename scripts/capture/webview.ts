/**
 * Bun.WebView wrapper — the live-auth half of evidence capture.
 *
 * Built on the probed Bun 1.4.4 API: `title`/`url`/`loading` are properties,
 * `onNavigated` is an assignable callback, `evaluate` needs a single expression
 * or IIFE, `screenshot` returns a Blob, `cdp` is a command-only sender, and the
 * only supported teardown is `await view.close()` (+ `Bun.WebView.closeAll()`
 * as a process-exit net).
 *
 * The wrapper exists so the CLI can be tested without a browser: load-wait and
 * fill-expression logic are pure exported helpers, and the CLI takes an
 * injectable browser runner.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseCdpCookies, type CdpCookie } from "./cookies.ts";
import { sha256Hex } from "./json.ts";
import { redactError, redactString, redactUrlForLog } from "./redact.ts";

export type WebViewErrorCode =
  | "launch-failed"
  | "unsupported-backend"
  | "invalid-url"
  | "invalid-selector"
  | "navigate-failed"
  | "load-timeout"
  | "selector-timeout"
  | "evaluate-failed"
  | "fill-failed"
  | "click-failed"
  | "press-failed"
  | "scroll-failed"
  | "screenshot-failed"
  | "cdp-failed"
  | "cookies-failed"
  | "closed";

export class WebViewError extends Error {
  readonly code: WebViewErrorCode;

  constructor(code: WebViewErrorCode, message: string) {
    super(message);
    this.name = "WebViewError";
    this.code = code;
  }
}

export interface WebViewLaunchOptions {
  width?: number;
  height?: number;
  /** CDP requires the Chrome backend; webkit has no `cdp()`. */
  backend?: "chrome" | "webkit";
  navigateTimeoutMs?: number;
  pollMs?: number;
  consoleLimit?: number;
}

export interface ConsoleLine {
  level: "log" | "error" | "warn";
  /** Redacted, single-line text. Page console output is untrusted input. */
  text: string;
}

export interface PageState {
  url: string;
  title: string;
  loading: boolean;
}

export interface ScreenshotResult {
  path: string;
  bytes: number;
  sha256: string;
}

export type ScreenshotOptions =
  { format: "png" } | { format: "jpeg"; quality: number };

/** Read-side contract used by the pure load-wait helper (fake in tests). */
export interface LoadState {
  url: string;
  title: string;
  loading: boolean;
  lastNavigatedUrl: string | null;
}

export interface LoadWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Require the URL to differ from this value (post-submit navigation). */
  requireUrlChangeFrom?: string;
  /** Allow `data:` URLs to count as settled (some portals bootstrap that way). */
  allowDataUrl?: boolean;
  /**
   * Allow an opaque bootstrap URL (`about:blank` / empty) to count as settled
   * once the document has loaded and has a title. Some portals (fantasy402)
   * serve their SPA while the native view still reports `about:blank`.
   */
  allowOpaqueUrl?: boolean;
}

export const DEFAULT_NAVIGATE_TIMEOUT_MS = 15_000;
export const DEFAULT_POLL_MS = 100;
const DEFAULT_CONSOLE_LIMIT = 200;
const MAX_CONSOLE_TEXT = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSettledUrl(
  url: string,
  allowDataUrl: boolean,
  allowOpaqueUrl: boolean = false,
): boolean {
  if (url.length === 0) return allowOpaqueUrl;
  if (url === "about:blank") return allowOpaqueUrl;
  if (url.startsWith("chrome-error://") || url.startsWith("chrome://")) {
    return false;
  }
  if (url.startsWith("data:")) return allowDataUrl;
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Poll `read()` until the page has loaded and its URL is a real http(s) page.
 * Pure over injected `sleep`/`now` so tests can make it deterministic.
 */
export async function waitForLoadState(
  read: () => LoadState,
  options: LoadWaitOptions = {},
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): Promise<{ url: string; title: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = read();
    const changed =
      options.requireUrlChangeFrom === undefined ||
      state.url !== options.requireUrlChangeFrom;
    if (
      !state.loading &&
      changed &&
      isSettledUrl(
        state.url,
        options.allowDataUrl === true,
        options.allowOpaqueUrl === true && state.title.length > 0,
      )
    ) {
      return { url: state.url, title: state.title };
    }
    if (now() >= deadline) {
      const reason = state.loading
        ? "still loading"
        : "not a settled http(s) page";
      throw new WebViewError(
        "load-timeout",
        `page did not settle within ${timeoutMs}ms (${reason}; url=${redactUrlForLog(state.url)})`,
      );
    }
    await sleep(pollMs);
  }
}

/** JSON/JS-escape a value for safe interpolation into an evaluate expression. */
export function escapeForExpression(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the IIFE used to clear and focus an input before `type()`.
 * The selector is JSON-encoded, so a hostile selector cannot break out.
 */
export function buildFillExpression(selector: string): string {
  const encoded = escapeForExpression(selector);
  return `(() => { const el = document.querySelector(${encoded}); if (el === null || typeof el.focus !== "function") return false; el.value = ""; el.focus(); return true; })()`;
}

/** Build the IIFE used to read a page identity snapshot without touching DOM secrets. */
export function buildPageProbeExpression(): string {
  return `(() => ({ url: location.href, title: document.title, bodyLength: document.body === null ? 0 : (document.body.innerText || "").length, hasPasswordField: document.querySelector("input[type=password]") !== null }))()`;
}

let exitCleanupRegistered = false;

/** Register the process-exit safety net once; never called in unit tests. */
export function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once("exit", () => {
    try {
      void Bun.WebView.closeAll();
    } catch {
      // Process exit: nothing actionable left to do.
    }
  });
}

type BunWebViewInstance = InstanceType<typeof Bun.WebView>;

/** Owns exactly one Bun.WebView; use `launch()` then `close()` in a finally. */
export class ManagedWebView {
  private readonly view: BunWebViewInstance;
  private readonly backend: "chrome" | "webkit";
  private readonly consoleLines: ConsoleLine[];
  private readonly consoleLimit: number;
  private readonly navigateTimeoutMs: number;
  private readonly pollMs: number;
  private lastNavigatedUrl: string | null = null;
  private closed = false;

  private constructor(
    view: BunWebViewInstance,
    backend: "chrome" | "webkit",
    consoleLines: ConsoleLine[],
    options: WebViewLaunchOptions,
  ) {
    this.view = view;
    this.backend = backend;
    this.consoleLines = consoleLines;
    this.consoleLimit = options.consoleLimit ?? DEFAULT_CONSOLE_LIMIT;
    this.navigateTimeoutMs =
      options.navigateTimeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  /** Launch a headless WebView and wire navigation/console capture. */
  static launch(options: WebViewLaunchOptions = {}): ManagedWebView {
    registerExitCleanup();
    const backend = options.backend ?? "chrome";
    const consoleLines: ConsoleLine[] = [];
    const consoleLimit = options.consoleLimit ?? DEFAULT_CONSOLE_LIMIT;
    let view: BunWebViewInstance;
    try {
      view = new Bun.WebView({
        width: options.width ?? 1440,
        height: options.height ?? 900,
        backend,
        console: (...args: unknown[]) => {
          if (consoleLines.length >= consoleLimit) return;
          consoleLines.push({
            level: "log",
            text: formatConsoleArgs(args),
          });
        },
      });
    } catch (error) {
      throw new WebViewError(
        "launch-failed",
        `failed to launch ${backend} WebView: ${redactError(error)}`,
      );
    }
    const managed = new ManagedWebView(view, backend, consoleLines, options);
    view.onNavigated = (url: string, title: string) => {
      managed.lastNavigatedUrl = url;
      managed.pushConsole(
        "log",
        `navigated: ${redactUrlForLog(url)} (${title})`,
      );
    };
    view.onNavigationFailed = (error: unknown) => {
      managed.pushConsole("error", `navigation failed: ${redactError(error)}`);
    };
    return managed;
  }

  get title(): string {
    return this.view.title;
  }

  get url(): string {
    return this.view.url;
  }

  get loading(): boolean {
    return this.view.loading;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pageState(): PageState {
    return {
      url: this.view.url,
      title: this.view.title,
      loading: this.view.loading,
    };
  }

  /** Redacted page console lines, bounded; never persisted by the capture store. */
  get consoleLog(): readonly ConsoleLine[] {
    return [...this.consoleLines];
  }

  private pushConsole(level: ConsoleLine["level"], text: string): void {
    if (this.consoleLines.length >= this.consoleLimit) return;
    this.consoleLines.push({
      level,
      text: redactString(text).slice(0, MAX_CONSOLE_TEXT),
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new WebViewError("closed", "WebView is closed");
  }

  /** Navigate and resolve once the page has settled. */
  async navigate(
    url: string,
    options: LoadWaitOptions = {},
  ): Promise<PageState> {
    this.assertOpen();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new WebViewError(
        "invalid-url",
        `navigate requires an absolute URL (got ${redactUrlForLog(url)})`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new WebViewError(
        "invalid-url",
        `navigate only supports http(s) URLs (got ${parsed.protocol})`,
      );
    }
    try {
      await this.view.navigate(url);
    } catch (error) {
      throw new WebViewError(
        "navigate-failed",
        `navigation to ${redactUrlForLog(url)} failed: ${redactError(error)}`,
      );
    }
    await this.waitForLoad(options);
    return this.pageState;
  }

  /** Wait for a settled page (post-navigation, submit or reload). */
  async waitForLoad(options: LoadWaitOptions = {}): Promise<PageState> {
    this.assertOpen();
    await waitForLoadState(
      () => ({
        url: this.view.url,
        title: this.view.title,
        loading: this.view.loading,
        lastNavigatedUrl: this.lastNavigatedUrl,
      }),
      {
        timeoutMs: options.timeoutMs ?? this.navigateTimeoutMs,
        pollMs: options.pollMs ?? this.pollMs,
        ...(options.requireUrlChangeFrom === undefined
          ? {}
          : { requireUrlChangeFrom: options.requireUrlChangeFrom }),
        ...(options.allowDataUrl === undefined
          ? {}
          : { allowDataUrl: options.allowDataUrl }),
        ...(options.allowOpaqueUrl === undefined
          ? {}
          : { allowOpaqueUrl: options.allowOpaqueUrl }),
      },
    );
    return this.pageState;
  }

  /**
   * Wait until `document.querySelector(selector)` exists and the document has
   * finished loading. Needed for SPAs whose shell "settles" before their
   * framework binds handlers (fantasy402): interacting earlier causes a native
   * form submit that discards the typed values.
   */
  async waitForSelector(
    selector: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<void> {
    this.assertOpen();
    const timeoutMs = options.timeoutMs ?? this.navigateTimeoutMs;
    const pollMs = options.pollMs ?? this.pollMs;
    const encoded = escapeForExpression(selector);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let ready = false;
      try {
        ready =
          (await this.evaluate(
            `(() => document.readyState === "complete" && document.querySelector(${encoded}) !== null)()`,
          )) === true;
      } catch {
        ready = false;
      }
      if (ready) return;
      if (Date.now() >= deadline) {
        throw new WebViewError(
          "selector-timeout",
          `element not found within ${timeoutMs}ms: ${selector}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Evaluate one expression or IIFE (multi-statement strings are invalid). */
  async evaluate(expression: string): Promise<unknown> {
    this.assertOpen();
    if (expression.trim().length === 0) {
      throw new WebViewError(
        "evaluate-failed",
        "evaluate requires an expression",
      );
    }
    try {
      return await this.view.evaluate(expression);
    } catch (error) {
      throw new WebViewError(
        "evaluate-failed",
        `evaluate failed: ${redactError(error)}`,
      );
    }
  }

  /** Wrap a multi-statement body in an IIFE before evaluating it. */
  async evaluateIife(body: string): Promise<unknown> {
    return this.evaluate(`(() => { ${body} })()`);
  }

  async click(selector: string): Promise<void> {
    this.assertOpen();
    assertSelector(selector, "click");
    try {
      await this.view.click(selector);
    } catch (error) {
      throw new WebViewError(
        "click-failed",
        `click on ${selector} failed: ${redactError(error)}`,
      );
    }
  }

  async press(key: string): Promise<void> {
    this.assertOpen();
    if (key.trim().length === 0) {
      throw new WebViewError("press-failed", "press requires a key name");
    }
    try {
      await this.view.press(key);
    } catch (error) {
      throw new WebViewError(
        "press-failed",
        `press ${key} failed: ${redactError(error)}`,
      );
    }
  }

  async scrollTo(selector: string): Promise<void> {
    this.assertOpen();
    assertSelector(selector, "scrollTo");
    try {
      await this.view.scrollTo(selector);
    } catch (error) {
      throw new WebViewError(
        "scroll-failed",
        `scrollTo ${selector} failed: ${redactError(error)}`,
      );
    }
  }

  /**
   * Fill one input: click, clear+focus via IIFE, then type into the focused
   * element. The typed value never appears in an evaluate expression or error.
   */
  async fill(selector: string, text: string): Promise<void> {
    this.assertOpen();
    assertSelector(selector, "fill");
    await this.click(selector);
    const focused = await this.evaluate(buildFillExpression(selector));
    if (focused !== true) {
      throw new WebViewError(
        "fill-failed",
        `no fillable element matched selector ${selector}`,
      );
    }
    try {
      await this.view.type(text);
    } catch (error) {
      throw new WebViewError(
        "fill-failed",
        `typing into ${selector} failed: ${redactError(error)}`,
      );
    }
    await this.evaluate(
      "(() => { if (document.activeElement) document.activeElement.blur(); return true; })()",
    );
  }

  /** Screenshot to a file: Blob -> bytes -> Bun.write. */
  async screenshotToFile(
    path: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult> {
    this.assertOpen();
    let blob: Blob;
    try {
      blob =
        options === undefined
          ? await this.view.screenshot()
          : options.format === "jpeg"
            ? await this.view.screenshot({
                format: "jpeg",
                quality: options.quality,
              })
            : await this.view.screenshot({ format: "png" });
    } catch (error) {
      throw new WebViewError(
        "screenshot-failed",
        `screenshot failed: ${redactError(error)}`,
      );
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, bytes);
    } catch (error) {
      throw new WebViewError(
        "screenshot-failed",
        `writing screenshot to ${path} failed: ${redactError(error)}`,
      );
    }
    return { path, bytes: bytes.length, sha256: sha256Hex(bytes) };
  }

  /** Send one CDP command (Chrome backend only; no event subscription exists). */
  async cdp(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertOpen();
    if (this.backend !== "chrome") {
      throw new WebViewError(
        "unsupported-backend",
        `cdp() requires backend "chrome" (current: ${this.backend})`,
      );
    }
    if (method.trim().length === 0) {
      throw new WebViewError("cdp-failed", "cdp requires a command name");
    }
    try {
      return params === undefined
        ? await this.view.cdp(method)
        : await this.view.cdp(method, params);
    } catch (error) {
      throw new WebViewError(
        "cdp-failed",
        `CDP ${method} failed: ${redactError(error)}`,
      );
    }
  }

  /** Read HttpOnly cookies via CDP (values are memory-only, never persisted). */
  async getAllCookies(): Promise<CdpCookie[]> {
    this.assertOpen();
    const result = await this.cdp("Network.getAllCookies");
    try {
      return parseCdpCookies(result);
    } catch (error) {
      throw new WebViewError(
        "cookies-failed",
        `could not parse CDP cookies: ${redactError(error)}`,
      );
    }
  }

  /**
   * Close the WebView. Teardown failures are not actionable (the process is
   * exiting), so this never throws; `Bun.WebView.closeAll()` is the backstop.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.view.close();
    } catch {
      try {
        Bun.WebView.closeAll();
      } catch {
        // Nothing else to do.
      }
    }
  }
}

function assertSelector(selector: string, action: string): void {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new WebViewError(
      "invalid-selector",
      `${action} requires a CSS selector`,
    );
  }
  if (/^\d+$/.test(trimmed)) {
    throw new WebViewError(
      "invalid-selector",
      `${action} expects a CSS selector, not a pixel count ("${trimmed}")`,
    );
  }
}

function formatConsoleArgs(args: readonly unknown[]): string {
  const text = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  return redactString(text).replace(/\s+/g, " ").slice(0, MAX_CONSOLE_TEXT);
}
