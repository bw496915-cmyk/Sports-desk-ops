/**
 * @file examples/bun-profiled-terminal/bun-profiled-terminal.ts
 * @description Profile-driven terminal orchestration for Bun: named color tokens, SQLite-backed
 * profile settings, reactive change watching, PTY sessions, and host console synchronization.
 *
 * Measured against the repository pin, Bun 1.4.4 (arm64-darwin), on 2026-11-18:
 *
 * 1. `Bun.inspect.defaults` does not exist. `Bun.inspect` accepts only
 *    `{ colors, depth, sorted, compact }`; `maxArrayLength` / `maxStringLength` are ignored by the
 *    native implementation. `applyProfileToHost()` therefore patches the global `console` methods
 *    and `Bun.inspect` itself, and restores both through `Disposable`.
 * 2. `Bun.markdown.AnsiTheme` accepts only `{ colors, columns, hyperlinks, light, kittyGraphics }`.
 *    Per-element callbacks are silently ignored by `Bun.markdown.ansi()`; they belong to
 *    `Bun.markdown.render()`. This module exposes both: native ANSI layout for body text and
 *    token-coloured callbacks for callers that want the profile palette in Markdown.
 * 3. `Bun.Terminal.write()` accepts every byte and buffers the remainder. Its return value is the
 *    byte length accepted, not a partial-write count, so re-sending a tail would duplicate output.
 * 4. `Bun.Terminal` is capability-detected rather than rejected on Windows. The Bun 1.4 notes
 *    quoted in `lib/bun_terminal.ts` advertise Linux, macOS and Windows support.
 */

import { Database } from "bun:sqlite";
import { accessSync, constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

// ============================================================================
// 1. Types & Constants
// ============================================================================

export type ColorDepth = "none" | "ansi16" | "ansi256" | "truecolor";
export type BunAnsiFormat = "ansi-16" | "ansi-256" | "ansi-16m";

export type ThemeRole =
  | "accent"
  | "error"
  | "warn"
  | "info"
  | "muted"
  | "code"
  | "border"
  | "bg"
  | "fg";

export const THEME_ROLES: readonly ThemeRole[] = [
  "accent",
  "error",
  "warn",
  "info",
  "muted",
  "code",
  "border",
  "bg",
  "fg",
];

export function isThemeRole(value: unknown): value is ThemeRole {
  return (
    typeof value === "string" &&
    (THEME_ROLES as readonly string[]).includes(value)
  );
}

export interface ProfileInspectSettings {
  /** Console/Bun.inspect object traversal depth (default: 2, Infinity allowed). */
  readonly consoleDepth: number;
  /** Sort object keys alphabetically during inspection (default: false). */
  readonly sorted: boolean;
  /** Compact single-line output when possible (default: false). */
  readonly compact: boolean;
  /** Max array elements shown before truncation (default: 100, Infinity allowed). */
  readonly maxArrayLength: number;
  /** Max string characters shown before truncation (default: Infinity). */
  readonly maxStringLength: number;
}

export const DEFAULT_INSPECT_SETTINGS: ProfileInspectSettings = {
  consoleDepth: 2,
  sorted: false,
  compact: false,
  maxArrayLength: 100,
  maxStringLength: Infinity,
};

export interface DerivedColorToken {
  readonly role: ThemeRole;
  /** Canonical CSS color name stored in DB & env (e.g., "red", "dodgerblue"). */
  readonly name: string;
  /** Packed 24-bit RGB integer from `Bun.color(name, "number")`. */
  readonly number: number;
  /** Hex representation (#rrggbb). */
  readonly hex: string;
  /** Native CSS color string (`Bun.color(name, "css")`). */
  readonly css: string;
  /** Individual 8-bit channels. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** WCAG 2.x relative luminance (0..1). */
  readonly luminance: number;
  /** Auto-derived high-contrast foreground color name ("black" or "white"). */
  readonly contrastFgName: "black" | "white";
  /** Native SGR foreground sequence from `Bun.color(name, ansiFormat)`. */
  readonly ansiFg: string;
  /** Native SGR background sequence. */
  readonly ansiBg: string;
  /** OSC 10 dynamic foreground sequence. */
  readonly osc10: string;
  /** OSC 11 dynamic background sequence. */
  readonly osc11: string;
}

export interface TerminalProfile {
  readonly profile: string;
  readonly depth: ColorDepth;
  readonly consoleDepth: number;
  readonly inspectSettings: ProfileInspectSettings;
  readonly tokens: Record<ThemeRole, DerivedColorToken | null>;
  /** Native `Bun.markdown.ansi()` renderer options. */
  readonly markdownTheme: Bun.markdown.AnsiTheme;
  /** Token-coloured callbacks for `Bun.markdown.render()`. */
  readonly markdownCallbacks: Bun.markdown.RenderCallbacks;
  /** Non-fatal resolution problems (unknown profile, invalid env value, ...). */
  readonly warnings: readonly string[];
  /** Render Markdown with native ANSI layout using this profile's theme options. */
  renderMarkdown: (markdown: string) => string;
  /** Render Markdown with per-role token colours via `Bun.markdown.render()`. */
  renderMarkdownThemed: (markdown: string) => string;
  /** Render a diagnostic card summarizing this profile's colors, depth, and env. */
  renderProfileCard: () => string;
  /** Inspect any value using this profile's consoleDepth, inspectSettings & colorDepth. */
  inspect: (value: unknown, overrideDepth?: number) => string;
  /** Print values formatted with this profile's consoleDepth & colorDepth. */
  log: (...values: unknown[]) => void;
  /** Export profile, named colors, inspect flags, and BUN_OPTIONS as env vars. */
  toEnv: (baseBunOptions?: string) => Record<string, string>;
}

export type TerminalInput = Parameters<Bun.Terminal["write"]>[0];

export interface ProfiledTerminalHandle {
  readonly terminal: Bun.Terminal;
  readonly profile: TerminalProfile;
  /** Write a string, BufferSource, or Blob into the PTY. */
  write: (input: TerminalInput | Blob) => Promise<number>;
  /** Collect all raw PTY output bytes into a Blob. */
  toBlob: () => Blob;
  /** Collect ANSI-stripped UTF-8 text into a Blob. */
  toCleanTextBlob: () => Promise<Blob>;
}

export interface CreateProfiledTerminalOptions {
  cols?: number;
  rows?: number;
  passthroughStdout?: boolean;
  onData?: (terminal: Bun.Terminal, data: Uint8Array) => void;
  onExit?: (
    terminal: Bun.Terminal,
    exitCode: number,
    signal: string | null,
  ) => void;
  onDrain?: (terminal: Bun.Terminal) => void;
}

export interface ProfiledPtySessionOptions {
  cmd: [string, ...string[]];
  profile?: TerminalProfile;
  profileName?: string;
  store?: NamedColorTokenStore;
  roleOverrides?: Partial<Record<ThemeRole, string>>;
  consoleDepthOverride?: number;
  inspectOverrides?: Partial<ProfileInspectSettings>;
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  interactive?: boolean;
  captureOutput?: boolean;
  maxCaptureBytes?: number;
  restoreScreenOnAbort?: boolean;
  /** Sync host Bun.inspect / console defaults during this session and restore on exit. */
  syncHostInspectDefaults?: boolean;
  /** Optional Markdown header rendered via Bun.markdown.ansi before child starts. */
  bannerMarkdown?: string;
  /** Optional Markdown footer rendered via Bun.markdown.ansi on exit. */
  footerMarkdown?: (summary: {
    exitCode: number;
    durationMs: number;
  }) => string;
  /** Intercept :::md ... ::: fenced blocks in child output and render via profile.renderMarkdown. */
  renderChildMarkdownBlocks?: boolean;
  onData?: (chunk: Uint8Array) => void;
}

export interface ProfiledPtySessionResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: "wall" | "idle" | null;
  aborted: boolean;
  durationMs: number;
  profile: string;
  colorDepth: ColorDepth;
  consoleDepth: number;
  rawOutput: string;
  cleanOutput: string;
  /** True when maxCaptureBytes cut the transcript short. */
  captureTruncated: boolean;
  /** Raw ANSI transcript packaged as a Blob (populated when captureOutput: true). */
  transcriptBlob: Blob;
}

export interface ProfilePreset {
  inspect: ProfileInspectSettings;
  colors: Partial<Record<ThemeRole, string>>;
}

export const BUILTIN_PROFILES: Record<string, ProfilePreset> = {
  default: {
    inspect: { ...DEFAULT_INSPECT_SETTINGS },
    colors: {
      accent: "dodgerblue",
      error: "red",
      warn: "gold",
      info: "mediumseagreen",
      muted: "slategray",
      code: "plum",
      border: "steelblue",
    },
  },
  "incident-red": {
    inspect: {
      consoleDepth: 5,
      sorted: true,
      compact: false,
      maxArrayLength: 250,
      maxStringLength: 500,
    },
    colors: {
      accent: "red",
      error: "crimson",
      warn: "gold",
      info: "coral",
      muted: "rosybrown",
      code: "lightsalmon",
      border: "indianred",
      bg: "maroon",
      fg: "white",
    },
  },
  "emerald-ops": {
    inspect: {
      consoleDepth: 3,
      sorted: false,
      compact: false,
      maxArrayLength: 150,
      maxStringLength: 1_000,
    },
    colors: {
      accent: "springgreen",
      error: "orangered",
      warn: "khaki",
      info: "aquamarine",
      muted: "darkseagreen",
      code: "palegreen",
      border: "seagreen",
    },
  },
  "amber-audit": {
    inspect: {
      consoleDepth: 6,
      sorted: true,
      compact: false,
      maxArrayLength: 500,
      maxStringLength: 2_000,
    },
    colors: {
      accent: "orange",
      error: "red",
      warn: "yellow",
      info: "wheat",
      muted: "tan",
      code: "moccasin",
      border: "peru",
    },
  },
  "compact-ci": {
    inspect: {
      consoleDepth: 1,
      sorted: true,
      compact: true,
      maxArrayLength: 25,
      maxStringLength: 80,
    },
    colors: {
      accent: "deepskyblue",
      error: "tomato",
      warn: "gold",
      info: "limegreen",
      muted: "darkgray",
      code: "violet",
      border: "dimgray",
    },
  },
};

const RESET_TERMINAL_SEQ = "\x1b[?1049l\x1b[?25h\x1b[0m";
const UNLIMITED_SENTINEL = 2_147_483_647;
const DEFAULT_CAPTURE_BYTES = 1024 * 1024;
const MARKDOWN_FENCE_RE = /:::md\r?\n([\s\S]*?)\r?\n:::/g;

/**
 * Native inspect captured at module load. `profile.inspect()` must not route through a host
 * `Bun.inspect` patched by `applyProfileToHost()`, or limits would be applied twice.
 */
const NATIVE_INSPECT = Bun.inspect.bind(Bun) as typeof Bun.inspect;

// ============================================================================
// 2. Color & Inspect Settings Normalization
// ============================================================================

export function normalizeNamedColor(
  input: string | null | undefined,
): string | null {
  if (typeof input !== "string") return null;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  return Bun.color(normalized, "number") !== null ? normalized : null;
}

function normalizeNonNegativeCount(
  input: string | number | null | undefined,
): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (input === Infinity) return Infinity;
    if (Number.isInteger(input) && input >= 0) return input;
    return null;
  }
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "infinity" || trimmed === "inf") return Infinity;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Console depth accepts `Infinity` (or `"infinity"` / `"inf"`) in addition to non-negative ints. */
export function normalizeConsoleDepth(
  input: string | number | null | undefined,
): number | null {
  return normalizeNonNegativeCount(input);
}

/** Array/string truncation limits use the same `Infinity`-aware grammar as console depth. */
export function normalizeInspectLength(
  input: string | number | null | undefined,
): number | null {
  return normalizeNonNegativeCount(input);
}

function normalizeBooleanEnv(
  input: string | boolean | null | undefined,
): boolean | null {
  if (typeof input === "boolean") return input;
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  return null;
}

function fgSgrToBgSgr(fgSgr: string): string {
  if (fgSgr.startsWith("\x1b[38;")) return `\x1b[48;${fgSgr.slice(5)}`;
  // eslint-disable-next-line no-control-regex -- parsing native ANSI SGR is the purpose
  const match = fgSgr.match(/^\x1b\[(\d+)m$/);
  if (match) {
    const code = Number(match[1]);
    if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      return `\x1b[${code + 10}m`;
    }
  }
  return "";
}

export function deriveColorToken(
  role: ThemeRole,
  colorName: string,
  ansiFormat: BunAnsiFormat | null,
): DerivedColorToken {
  const canonicalName = normalizeNamedColor(colorName);
  if (!canonicalName) {
    throw new Error(
      `ERR_COLOR_INVALID: "${colorName}" is not a recognized CSS color name.`,
    );
  }

  const number = Bun.color(canonicalName, "number");
  if (number === null) {
    throw new Error(
      `ERR_COLOR_INVALID: "${canonicalName}" has no numeric representation.`,
    );
  }

  const r = (number >> 16) & 0xff;
  const g = (number >> 8) & 0xff;
  const b = number & 0xff;
  const hex =
    Bun.color(canonicalName, "hex") ??
    `#${number.toString(16).padStart(6, "0")}`;
  const css = Bun.color(canonicalName, "css") ?? `rgb(${r}, ${g}, ${b})`;

  const linearize = (channel: number) => {
    const scaled = channel / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  const contrastFgName: "black" | "white" =
    luminance > 0.179 ? "black" : "white";

  const ansiFg = ansiFormat ? (Bun.color(canonicalName, ansiFormat) ?? "") : "";
  const ansiBg = ansiFg ? fgSgrToBgSgr(ansiFg) : "";

  return {
    role,
    name: canonicalName,
    number,
    hex,
    css,
    r,
    g,
    b,
    luminance,
    contrastFgName,
    ansiFg,
    ansiBg,
    osc10: `\x1b]10;${hex}\x07`,
    osc11: `\x1b]11;${hex}\x07`,
  };
}

export function detectColorDepth(
  env: Record<string, string>,
  isTTY: boolean,
): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.FORCE_COLOR !== undefined) {
    const forceColor = env.FORCE_COLOR.trim().toLowerCase();
    if (forceColor === "0" || forceColor === "false") return "none";
    if (forceColor === "1") return "ansi16";
    if (forceColor === "2") return "ansi256";
    if (forceColor === "3" || forceColor === "true" || forceColor === "") {
      return "truecolor";
    }
  }
  const colorTerm = (env.COLORTERM ?? "").toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return "truecolor";
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return "none";
  if (term.includes("truecolor") || term.includes("24bit")) return "truecolor";
  if (term.includes("256color")) return "ansi256";
  return isTTY ? "truecolor" : "none";
}

export function depthToAnsiFormat(depth: ColorDepth): BunAnsiFormat | null {
  switch (depth) {
    case "truecolor":
      return "ansi-16m";
    case "ansi256":
      return "ansi-256";
    case "ansi16":
      return "ansi-16";
    case "none":
      return null;
  }
}

function decodeLimit(value: number): number {
  return value >= UNLIMITED_SENTINEL ? Infinity : value;
}

function encodeLimit(value: number): number {
  return value === Infinity ? UNLIMITED_SENTINEL : value;
}

function settingsEqual(
  left: ProfileInspectSettings,
  right: ProfileInspectSettings,
): boolean {
  return (
    left.consoleDepth === right.consoleDepth &&
    left.sorted === right.sorted &&
    left.compact === right.compact &&
    left.maxArrayLength === right.maxArrayLength &&
    left.maxStringLength === right.maxStringLength
  );
}

function validateProfileName(profile: string): string {
  if (typeof profile !== "string" || profile.trim().length === 0) {
    throw new Error(
      "ERR_PROFILE_NAME_INVALID: profile must be a non-empty string.",
    );
  }
  return profile.trim();
}

// ============================================================================
// 3. Inspect Limits (maxArrayLength / maxStringLength shim)
// ============================================================================

class InspectTruncationMarker {
  constructor(private readonly label: string) {}

  [Bun.inspect.custom](): string {
    return `... ${this.label}`;
  }
}

function truncateString(value: string, limit: number): string {
  if (limit === Infinity || value.length <= limit) return value;
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  const omitted = characters.length - limit;
  return `${characters.slice(0, limit).join("")}… (${omitted} more chars)`;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Bun 1.4.4's `Bun.inspect` ignores `maxArrayLength` and `maxStringLength`. This clone applies
 * those two limits before inspection. It only clones arrays and plain objects: class instances,
 * Maps, Sets, typed arrays and Errors pass through untouched so inspecting `process`, an Error or a
 * native handle cannot accidentally deep-copy it.
 */
export function applyInspectLimits(
  value: unknown,
  maxArrayLength: number,
  maxStringLength: number,
): unknown {
  if (maxArrayLength === Infinity && maxStringLength === Infinity) return value;
  const seen = new WeakMap<object, unknown>();

  const transform = (input: unknown): unknown => {
    if (typeof input === "string") {
      return truncateString(input, maxStringLength);
    }
    if (input === null || typeof input !== "object") return input;
    if (input instanceof InspectTruncationMarker) return input;

    const cached = seen.get(input);
    if (cached !== undefined) return cached;

    if (Array.isArray(input)) {
      const output: unknown[] = [];
      seen.set(input, output);
      const kept = Math.min(input.length, maxArrayLength);
      for (let index = 0; index < kept; index += 1) {
        if (index in input) output[index] = transform(input[index]);
      }
      if (input.length > kept) {
        output.push(
          new InspectTruncationMarker(`${input.length - kept} more items`),
        );
      }
      return output;
    }

    if (!isPlainObject(input)) return input;

    const output = Object.create(Object.getPrototypeOf(input)) as Record<
      PropertyKey,
      unknown
    >;
    seen.set(input, output);
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor) continue;
      if ("value" in descriptor) descriptor.value = transform(descriptor.value);
      Object.defineProperty(output, key, descriptor);
    }
    return output;
  };

  return transform(value);
}

export function inspectValue(
  value: unknown,
  settings: ProfileInspectSettings,
  colors: boolean,
): string {
  const prepared = applyInspectLimits(
    value,
    settings.maxArrayLength,
    settings.maxStringLength,
  );
  return NATIVE_INSPECT(prepared, {
    depth: settings.consoleDepth,
    colors,
    sorted: settings.sorted,
    compact: settings.compact,
  });
}

// ============================================================================
// 4. NamedColorTokenStore (bun:sqlite persistence, reactivity, clone & diff)
// ============================================================================

export type ProfileChangeListener = (profile: string) => void;

export class NamedColorTokenStore {
  private readonly db: Database;
  private readonly listeners = new Set<ProfileChangeListener>();
  private mutationDepth = 0;
  private readonly pendingNotifications = new Set<string>();
  private notifying = false;
  private isClosed = false;

  constructor(dbPath = ":memory:", seedBuiltins = true) {
    this.db = new Database(dbPath, { create: true });
    this.migrate();
    if (seedBuiltins) {
      for (const [profileName, preset] of Object.entries(BUILTIN_PROFILES)) {
        this.setProfile(profileName, preset.colors, preset.inspect, false);
      }
    }
  }

  get closed(): boolean {
    return this.isClosed;
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS theme_tokens (
        profile TEXT NOT NULL,
        role TEXT NOT NULL,
        color_name TEXT NOT NULL CHECK (length(trim(color_name)) > 0),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (profile, role)
      ) STRICT;
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS profile_settings (
        profile TEXT PRIMARY KEY,
        console_depth INTEGER NOT NULL DEFAULT 2 CHECK (console_depth >= 0),
        sorted INTEGER NOT NULL DEFAULT 0 CHECK (sorted IN (0, 1)),
        compact INTEGER NOT NULL DEFAULT 0 CHECK (compact IN (0, 1)),
        max_array_length INTEGER NOT NULL DEFAULT 100 CHECK (max_array_length >= 0),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      ) STRICT;
    `);

    // Forward migration for databases created before maxStringLength existed.
    const columns = new Set(
      this.db
        .query<{ name: string }, []>("PRAGMA table_info(profile_settings)")
        .all()
        .map((row) => row.name),
    );
    if (!columns.has("max_string_length")) {
      this.db.run(
        `ALTER TABLE profile_settings
         ADD COLUMN max_string_length INTEGER NOT NULL DEFAULT ${UNLIMITED_SENTINEL}
         CHECK (max_string_length >= 0)`,
      );
    }
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new Error("ERR_STORE_CLOSED: the profile store has been closed.");
    }
  }

  /**
   * Runs a mutation in one transaction and flushes notifications once after commit. Nested calls
   * join the outer transaction instead of opening a savepoint, so `setProfile()` notifies once.
   */
  private mutate<T>(operation: () => T): T {
    this.assertOpen();
    if (this.notifying) {
      throw new Error(
        "ERR_STORE_REENTRANT: profile change listeners must not mutate the store.",
      );
    }
    const outer = this.mutationDepth === 0;
    this.mutationDepth += 1;
    try {
      const result = outer ? this.db.transaction(operation)() : operation();
      if (outer) this.flushNotifications();
      return result;
    } catch (error) {
      if (outer) this.pendingNotifications.clear();
      throw error;
    } finally {
      this.mutationDepth -= 1;
    }
  }

  private notify(profile: string): void {
    this.pendingNotifications.add(profile);
  }

  private flushNotifications(): void {
    if (this.pendingNotifications.size === 0) return;
    const profiles = [...this.pendingNotifications];
    this.pendingNotifications.clear();
    const listeners = [...this.listeners];
    if (listeners.length === 0) return;

    const errors: unknown[] = [];
    this.notifying = true;
    try {
      for (const profile of profiles) {
        for (const listener of listeners) {
          try {
            listener(profile);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    } finally {
      this.notifying = false;
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "One or more profile change listeners failed after the transaction committed.",
      );
    }
  }

  /**
   * Subscribe to committed profile mutations. The listener receives the profile name; re-resolve
   * that profile to hot-reload OSC 10/11 and Markdown output. Returns an idempotent unsubscribe.
   *
   * Listeners run after the transaction commits. A throwing listener does not prevent the other
   * listeners from running, but the first error (or an `AggregateError`) is rethrown to the caller
   * that mutated the store. Listeners must not mutate the store (ERR_STORE_REENTRANT).
   */
  watchProfile(listener: ProfileChangeListener): () => void {
    this.assertOpen();
    if (typeof listener !== "function") {
      throw new Error(
        "ERR_PROFILE_LISTENER_INVALID: listener must be a function.",
      );
    }
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  /** Alias for {@link watchProfile}. */
  onProfileChange(listener: ProfileChangeListener): () => void {
    return this.watchProfile(listener);
  }

  setToken(profile: string, role: ThemeRole, colorName: string): string {
    const profileName = validateProfileName(profile);
    if (!isThemeRole(role)) {
      throw new Error(
        `ERR_THEME_ROLE_INVALID: "${String(role)}" is not a theme role.`,
      );
    }
    const valid = normalizeNamedColor(colorName);
    if (!valid) {
      throw new Error(
        `ERR_COLOR_INVALID: "${colorName}" is not a valid color name.`,
      );
    }

    this.mutate(() => {
      if (this.getTokenName(profileName, role) === valid) return;
      this.db
        .query(
          `INSERT INTO theme_tokens (profile, role, color_name, updated_at)
           VALUES (?1, ?2, ?3, unixepoch())
           ON CONFLICT(profile, role) DO UPDATE SET
             color_name = excluded.color_name,
             updated_at = unixepoch()`,
        )
        .run(profileName, role, valid);
      this.notify(profileName);
    });
    return valid;
  }

  setInspectSettings(
    profile: string,
    settings: Partial<ProfileInspectSettings>,
    overwrite = true,
  ): ProfileInspectSettings {
    const profileName = validateProfileName(profile);
    if (settings === null || typeof settings !== "object") {
      throw new Error(
        "ERR_INSPECT_SETTINGS_INVALID: settings must be an object.",
      );
    }

    const current =
      this.getInspectSettings(profileName) ?? DEFAULT_INSPECT_SETTINGS;
    const consoleDepth =
      settings.consoleDepth !== undefined
        ? normalizeConsoleDepth(settings.consoleDepth)
        : current.consoleDepth;
    if (consoleDepth === null) {
      throw new Error(
        `ERR_CONSOLE_DEPTH_INVALID: "${String(settings.consoleDepth)}" is invalid.`,
      );
    }

    const maxArrayLength =
      settings.maxArrayLength !== undefined
        ? normalizeInspectLength(settings.maxArrayLength)
        : current.maxArrayLength;
    if (maxArrayLength === null) {
      throw new Error(
        `ERR_MAX_ARRAY_LENGTH_INVALID: "${String(settings.maxArrayLength)}" is invalid.`,
      );
    }

    const maxStringLength =
      settings.maxStringLength !== undefined
        ? normalizeInspectLength(settings.maxStringLength)
        : current.maxStringLength;
    if (maxStringLength === null) {
      throw new Error(
        `ERR_MAX_STRING_LENGTH_INVALID: "${String(settings.maxStringLength)}" is invalid.`,
      );
    }

    if (settings.sorted !== undefined && typeof settings.sorted !== "boolean") {
      throw new Error("ERR_INSPECT_SORTED_INVALID: sorted must be a boolean.");
    }
    if (
      settings.compact !== undefined &&
      typeof settings.compact !== "boolean"
    ) {
      throw new Error(
        "ERR_INSPECT_COMPACT_INVALID: compact must be a boolean.",
      );
    }

    const merged: ProfileInspectSettings = {
      consoleDepth,
      sorted: settings.sorted ?? current.sorted,
      compact: settings.compact ?? current.compact,
      maxArrayLength,
      maxStringLength,
    };

    this.mutate(() => {
      if (!overwrite) {
        if (this.getInspectSettings(profileName) !== null) return;
      } else if (
        this.getInspectSettings(profileName) !== null &&
        settingsEqual(this.getInspectSettings(profileName)!, merged)
      ) {
        return;
      }

      this.writeInspectSettings(profileName, merged, overwrite);
      this.notify(profileName);
    });

    return this.getInspectSettings(profileName) ?? merged;
  }

  private writeInspectSettings(
    profile: string,
    settings: ProfileInspectSettings,
    overwrite: boolean,
  ): void {
    const sql = overwrite
      ? `INSERT INTO profile_settings
           (profile, console_depth, sorted, compact, max_array_length, max_string_length, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())
         ON CONFLICT(profile) DO UPDATE SET
           console_depth = excluded.console_depth,
           sorted = excluded.sorted,
           compact = excluded.compact,
           max_array_length = excluded.max_array_length,
           max_string_length = excluded.max_string_length,
           updated_at = unixepoch()`
      : `INSERT OR IGNORE INTO profile_settings
           (profile, console_depth, sorted, compact, max_array_length, max_string_length, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())`;
    this.db
      .query(sql)
      .run(
        profile,
        encodeLimit(settings.consoleDepth),
        settings.sorted ? 1 : 0,
        settings.compact ? 1 : 0,
        encodeLimit(settings.maxArrayLength),
        encodeLimit(settings.maxStringLength),
      );
  }

  setConsoleDepth(profile: string, depth: number, overwrite = true): number {
    return this.setInspectSettings(profile, { consoleDepth: depth }, overwrite)
      .consoleDepth;
  }

  getInspectSettings(profile: string): ProfileInspectSettings | null {
    this.assertOpen();
    const row = this.db
      .query<
        {
          console_depth: number;
          sorted: number;
          compact: number;
          max_array_length: number;
          max_string_length: number;
        },
        [string]
      >(
        `SELECT console_depth, sorted, compact, max_array_length, max_string_length
         FROM profile_settings WHERE profile = ?1`,
      )
      .get(profile);
    if (!row) return null;
    return {
      consoleDepth: decodeLimit(row.console_depth),
      sorted: row.sorted === 1,
      compact: row.compact === 1,
      maxArrayLength: decodeLimit(row.max_array_length),
      maxStringLength: decodeLimit(row.max_string_length),
    };
  }

  getConsoleDepth(profile: string): number | null {
    return this.getInspectSettings(profile)?.consoleDepth ?? null;
  }

  setProfile(
    profile: string,
    roles: Partial<Record<ThemeRole, string>>,
    inspect?: number | Partial<ProfileInspectSettings>,
    overwrite = true,
  ): void {
    const profileName = validateProfileName(profile);
    if (roles === null || typeof roles !== "object") {
      throw new Error("ERR_PROFILE_ROLES_INVALID: roles must be an object.");
    }

    this.mutate(() => {
      let changed = false;
      for (const [role, rawName] of Object.entries(roles)) {
        if (rawName === undefined) continue;
        if (!isThemeRole(role)) {
          throw new Error(
            `ERR_THEME_ROLE_INVALID: "${role}" is not a theme role.`,
          );
        }
        const valid = normalizeNamedColor(rawName);
        if (!valid) {
          throw new Error(
            `ERR_COLOR_INVALID: "${rawName}" for role "${role}".`,
          );
        }
        const existing = this.getTokenName(profileName, role);
        if (existing === valid) continue;
        if (!overwrite && existing !== null) continue;
        this.db
          .query(
            `INSERT INTO theme_tokens (profile, role, color_name, updated_at)
             VALUES (?1, ?2, ?3, unixepoch())
             ON CONFLICT(profile, role) DO UPDATE SET
               color_name = excluded.color_name,
               updated_at = unixepoch()`,
          )
          .run(profileName, role, valid);
        changed = true;
      }

      if (inspect !== undefined) {
        const patch =
          typeof inspect === "number" ? { consoleDepth: inspect } : inspect;
        const before = this.getInspectSettings(profileName);
        this.setInspectSettings(profileName, patch, overwrite);
        const after = this.getInspectSettings(profileName);
        if (
          before === null
            ? after !== null
            : after !== null && !settingsEqual(before, after)
        ) {
          changed = true;
        }
      }

      if (changed) this.notify(profileName);
    });
  }

  /**
   * Atomically copy the effective color map and inspect settings from `source` to `target`.
   * The target is replaced, not merged. Because the clone is effective, a custom profile with only
   * a few stored tokens still materialises the roles it would inherit from `default`; a builtin-only
   * source works on an unseeded store.
   */
  cloneProfile(source: string, target: string): void {
    const sourceName = validateProfileName(source);
    const targetName = validateProfileName(target);
    if (sourceName === targetName) {
      throw new Error("ERR_PROFILE_CLONE_SELF: source and target must differ.");
    }

    this.mutate(() => {
      if (!this.profileExists(sourceName)) {
        throw new Error(
          `ERR_PROFILE_UNKNOWN: no stored rows or builtin preset for "${sourceName}".`,
        );
      }

      // Clone the profile a resolver would actually produce, not just its stored rows: a custom
      // profile with three stored tokens still inherits the remaining roles from "default".
      const tokens = this.effectiveTokens(sourceName);
      const settings = this.effectiveSettings(sourceName);

      this.db
        .query("DELETE FROM theme_tokens WHERE profile = ?1")
        .run(targetName);
      const insert = this.db.query(
        `INSERT INTO theme_tokens (profile, role, color_name, updated_at)
         VALUES (?1, ?2, ?3, unixepoch())`,
      );
      for (const [role, colorName] of Object.entries(tokens)) {
        if (colorName === undefined) continue;
        insert.run(targetName, role, colorName);
      }
      this.writeInspectSettings(targetName, settings, true);
      this.notify(targetName);
    });
  }

  getTokenName(profile: string, role: ThemeRole): string | null {
    this.assertOpen();
    const row = this.db
      .query<{ color_name: string }, [string, string]>(
        `SELECT color_name FROM theme_tokens WHERE profile = ?1 AND role = ?2`,
      )
      .get(profile, role);
    return row ? row.color_name : null;
  }

  getProfileMap(profile: string): Partial<Record<ThemeRole, string>> {
    this.assertOpen();
    const rows = this.db
      .query<{ role: string; color_name: string }, [string]>(
        `SELECT role, color_name FROM theme_tokens WHERE profile = ?1`,
      )
      .all(profile);
    const output: Partial<Record<ThemeRole, string>> = {};
    for (const row of rows) {
      if (isThemeRole(row.role)) output[row.role] = row.color_name;
    }
    return output;
  }

  listProfiles(): string[] {
    this.assertOpen();
    return this.db
      .query<{ profile: string }, []>(
        `SELECT profile FROM theme_tokens
         UNION
         SELECT profile FROM profile_settings
         ORDER BY profile`,
      )
      .all()
      .map((row) => row.profile);
  }

  hasProfile(profile: string): boolean {
    this.assertOpen();
    const row = this.db
      .query<{ present: number }, [string]>(
        `SELECT (EXISTS(SELECT 1 FROM theme_tokens WHERE profile = ?1)
              OR EXISTS(SELECT 1 FROM profile_settings WHERE profile = ?1)) AS present`,
      )
      .get(profile);
    return row?.present === 1;
  }

  private effectiveSettings(profile: string): ProfileInspectSettings {
    const stored = this.getInspectSettings(profile);
    if (stored !== null) return stored;
    const builtin = BUILTIN_PROFILES[profile] ?? BUILTIN_PROFILES.default!;
    return { ...DEFAULT_INSPECT_SETTINGS, ...builtin.inspect };
  }

  private effectiveTokens(profile: string): Partial<Record<ThemeRole, string>> {
    const builtin = BUILTIN_PROFILES[profile] ?? BUILTIN_PROFILES.default!;
    const resolved: Partial<Record<ThemeRole, string>> = { ...builtin.colors };
    for (const [role, colorName] of Object.entries(
      this.getProfileMap(profile),
    )) {
      if (colorName !== undefined) resolved[role as ThemeRole] = colorName;
    }
    return resolved;
  }

  private profileExists(profile: string): boolean {
    return this.hasProfile(profile) || BUILTIN_PROFILES[profile] !== undefined;
  }

  /**
   * Markdown comparison of two profiles' effective color tokens and inspect settings.
   * Render the returned string with `profile.renderMarkdown(...)`.
   */
  diffProfiles(profileA: string, profileB: string): string {
    const a = validateProfileName(profileA);
    const b = validateProfileName(profileB);
    if (!this.profileExists(a) && !this.profileExists(b)) {
      throw new Error(
        `ERR_PROFILE_UNKNOWN: neither "${a}" nor "${b}" exists in the store or builtins.`,
      );
    }

    const tokensA = this.effectiveTokens(a);
    const tokensB = this.effectiveTokens(b);
    const settingsA = this.effectiveSettings(a);
    const settingsB = this.effectiveSettings(b);
    const markdownSafe = (value: string) =>
      value.replace(/\|/g, "\\|").replace(/`/g, "\\`");
    const labelA = markdownSafe(a);
    const labelB = markdownSafe(b);

    const change = (left: unknown, right: unknown) =>
      left !== right ? "**YES**" : "no";
    const showSetting = (value: number | boolean | null | undefined) => {
      if (value === null || value === undefined) return "`(unset)`";
      if (value === Infinity) return "`∞`";
      return `\`${String(value)}\``;
    };
    const showColor = (value: string | undefined) =>
      value === undefined ? "`(unset)`" : `\`${value}\``;

    const missing = [a, b].filter((name) => !this.profileExists(name));
    const lines = [
      `## Profile diff: \`${markdownSafe(a)}\` vs \`${markdownSafe(b)}\``,
      ``,
      `> Effective values: stored rows take precedence; missing values fall back to the profile's builtin preset.`,
      ...(missing.length > 0
        ? [
            `> **Note**: ${missing.map((name) => `\`${name}\``).join(", ")} has no stored rows or builtin preset; its effective values come from \`default\`.`,
          ]
        : []),
      ``,
      `| Key | \`${labelA}\` | \`${labelB}\` | Changed |`,
      `| :--- | :--- | :--- | :--- |`,
      `| \`consoleDepth\` | ${showSetting(settingsA?.consoleDepth)} | ${showSetting(settingsB?.consoleDepth)} | ${change(settingsA?.consoleDepth, settingsB?.consoleDepth)} |`,
      `| \`sorted\` | ${showSetting(settingsA?.sorted)} | ${showSetting(settingsB?.sorted)} | ${change(settingsA?.sorted, settingsB?.sorted)} |`,
      `| \`compact\` | ${showSetting(settingsA?.compact)} | ${showSetting(settingsB?.compact)} | ${change(settingsA?.compact, settingsB?.compact)} |`,
      `| \`maxArrayLength\` | ${showSetting(settingsA?.maxArrayLength)} | ${showSetting(settingsB?.maxArrayLength)} | ${change(settingsA?.maxArrayLength, settingsB?.maxArrayLength)} |`,
      `| \`maxStringLength\` | ${showSetting(settingsA?.maxStringLength)} | ${showSetting(settingsB?.maxStringLength)} | ${change(settingsA?.maxStringLength, settingsB?.maxStringLength)} |`,
    ];

    for (const role of THEME_ROLES) {
      const colorA = tokensA[role];
      const colorB = tokensB[role];
      lines.push(
        `| \`${role}\` | ${showColor(colorA)} | ${showColor(colorB)} | ${change(colorA, colorB)} |`,
      );
    }

    return lines.join("\n");
  }

  /** Backwards-compatible alias for {@link diffProfiles}. */
  diffProfilesMarkdown(profileA: string, profileB: string): string {
    return this.diffProfiles(profileA, profileB);
  }

  toEnvRecord(profile: string, prefix = "PTY"): Record<string, string> {
    const profileName = validateProfileName(profile);
    const tokens = this.effectiveTokens(profileName);
    const settings = this.effectiveSettings(profileName);
    const env: Record<string, string> = { [`${prefix}_PROFILE`]: profileName };

    if (settings) {
      env[`${prefix}_CONSOLE_DEPTH`] =
        settings.consoleDepth === Infinity
          ? "Infinity"
          : String(settings.consoleDepth);
      env[`${prefix}_INSPECT_SORTED`] = settings.sorted ? "1" : "0";
      env[`${prefix}_INSPECT_COMPACT`] = settings.compact ? "1" : "0";
      env[`${prefix}_MAX_ARRAY_LENGTH`] =
        settings.maxArrayLength === Infinity
          ? "Infinity"
          : String(settings.maxArrayLength);
      env[`${prefix}_MAX_STRING_LENGTH`] =
        settings.maxStringLength === Infinity
          ? "Infinity"
          : String(settings.maxStringLength);
    }

    for (const [role, colorName] of Object.entries(tokens)) {
      if (colorName !== undefined) {
        env[`${prefix}_${role.toUpperCase()}`] = colorName;
      }
    }
    return env;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.listeners.clear();
    this.pendingNotifications.clear();
    this.db.close();
  }
}

// ============================================================================
// 5. Markdown Themes, Host Sync & Profile Resolver
// ============================================================================

/**
 * Native `Bun.markdown.ansi()` options. In Bun 1.4.4 `AnsiTheme` has no per-role hooks: it only
 * toggles colors/hyperlinks/light/columns/kittyGraphics. Token colours reach Markdown through
 * {@link buildMarkdownRenderCallbacks} instead.
 */
export function buildMarkdownAnsiTheme(
  tokens: Record<ThemeRole, DerivedColorToken | null>,
  depth: ColorDepth,
  getWidth: () => number = () => process.stdout.columns ?? 80,
): Bun.markdown.AnsiTheme {
  const width = Math.max(0, Math.trunc(getWidth()));
  if (depth === "none") {
    const theme: Bun.markdown.AnsiTheme = { colors: false };
    if (width > 0) theme.columns = width;
    return theme;
  }

  const theme: Bun.markdown.AnsiTheme = {
    colors: true,
    hyperlinks: true,
    columns: width > 0 ? width : 80,
  };
  const background = tokens.bg;
  if (background) theme.light = background.luminance > 0.5;
  return theme;
}

/**
 * Profile-coloured `Bun.markdown.render()` callbacks. Unlike `Bun.markdown.ansi()` this renderer has
 * no table-alignment or word-wrap engine, so it is offered for callers that prefer the profile
 * palette over native layout.
 */
export function buildMarkdownRenderCallbacks(
  tokens: Record<ThemeRole, DerivedColorToken | null>,
  depth: ColorDepth,
  getWidth: () => number = () => process.stdout.columns ?? 80,
): Bun.markdown.RenderCallbacks {
  const color = (role: ThemeRole) =>
    depth === "none" ? "" : (tokens[role]?.ansiFg ?? "");
  const paint = (role: ThemeRole, text: string, reset = "\x1b[0m") => {
    const prefix = color(role);
    return prefix ? `${prefix}${text}${reset}` : text;
  };
  const width = Math.max(20, Math.min(getWidth(), 80));

  return {
    heading: (children, meta) => {
      const sgr =
        meta.level === 1
          ? `\x1b[1;4m${color("accent")}`
          : meta.level === 2
            ? `\x1b[1m${color("info")}`
            : `\x1b[1m${color("warn")}`;
      const painted = depth === "none" ? children : `${sgr}${children}\x1b[0m`;
      return `\n${"#".repeat(meta.level)} ${painted}\n`;
    },
    paragraph: (children) => `${children}\n\n`,
    strong: (children) => paint("warn", children, "\x1b[22m"),
    emphasis: (children) => `\x1b[3m${children}\x1b[23m`,
    strikethrough: (children) =>
      depth === "none"
        ? children
        : `${color("muted")}\x1b[9m${children}\x1b[29m\x1b[39m`,
    codespan: (children) =>
      depth === "none"
        ? `\`${children}\``
        : `${color("code")}\`${children}\`\x1b[39m`,
    code: (children, meta) => {
      const language = meta?.language;
      const tag = language ? `┌─ ${language}\n` : "";
      const body = children
        .replace(/\n$/, "")
        .split("\n")
        .map((line) =>
          depth === "none"
            ? `│ ${line}`
            : `${color("muted")}│\x1b[39m ${color("code")}${line}\x1b[39m`,
        )
        .join("\n");
      return `\n${tag}${body}\n`;
    },
    blockquote: (children) => {
      const lines = children
        .trimEnd()
        .split("\n")
        .map((line) =>
          depth === "none"
            ? `> ${line}`
            : `${color("border")}┃\x1b[39m \x1b[3m${line}\x1b[23m`,
        )
        .join("\n");
      return `\n${lines}\n`;
    },
    link: (children, meta) =>
      depth === "none"
        ? `${children} (${meta.href})`
        : `${color("accent")}\x1b[4m${children}\x1b[24m\x1b[39m ${color("muted")}(${meta.href})\x1b[39m`,
    image: (alt, meta) =>
      depth === "none"
        ? `[img: ${alt || meta.src}]`
        : `${color("muted")}[img: ${alt || meta.src}]\x1b[39m`,
    list: (children) => children,
    listItem: (children, meta) => {
      if (typeof meta.checked === "boolean") {
        const box =
          depth === "none"
            ? meta.checked
              ? "[x]"
              : "[ ]"
            : meta.checked
              ? `${color("info")}[✔]\x1b[39m`
              : `${color("error")}[ ]\x1b[39m`;
        return `${box} ${children.trimEnd()}\n`;
      }
      const marker = meta.ordered
        ? `${meta.start !== undefined ? meta.start + meta.index : meta.index + 1}.`
        : "•";
      return `${depth === "none" ? marker : paint("accent", marker)} ${children.trimEnd()}\n`;
    },
    hr: () =>
      depth === "none"
        ? `\n${"─".repeat(width)}\n`
        : `\n${color("border")}${"─".repeat(width)}\x1b[39m\n`,
    table: (children) => `\n${children}\n`,
    thead: (children) => `\x1b[1m${children}\x1b[0m`,
    tr: (children) =>
      depth === "none"
        ? `${children}\n`
        : `${color("border")}│\x1b[39m${children}\n`,
    th: (children) => ` ${children.trim()} │`,
    td: (children) => ` ${children.trim()} │`,
  };
}

interface ResolvedInspectOptions {
  consoleDepth: number;
  colors: boolean;
  sorted: boolean;
  compact: boolean;
  maxArrayLength: number;
  maxStringLength: number;
}

function resolveInspectOptions(
  profile: TerminalProfile,
  overrides: unknown,
): ResolvedInspectOptions {
  const raw =
    overrides !== null && typeof overrides === "object"
      ? (overrides as Record<string, unknown>)
      : {};
  const numberOr = (value: unknown, fallback: number): number => {
    if (typeof value !== "number") return fallback;
    const normalized = normalizeInspectLength(value);
    return normalized === null ? fallback : normalized;
  };
  return {
    consoleDepth: numberOr(raw.depth, profile.consoleDepth),
    colors:
      typeof raw.colors === "boolean" ? raw.colors : profile.depth !== "none",
    sorted:
      typeof raw.sorted === "boolean"
        ? raw.sorted
        : profile.inspectSettings.sorted,
    compact:
      typeof raw.compact === "boolean"
        ? raw.compact
        : profile.inspectSettings.compact,
    maxArrayLength: numberOr(
      raw.maxArrayLength,
      profile.inspectSettings.maxArrayLength,
    ),
    maxStringLength: numberOr(
      raw.maxStringLength,
      profile.inspectSettings.maxStringLength,
    ),
  };
}

/**
 * Format `console.log`-style arguments with the profile's inspect settings. Strings stay literal
 * (so `console.log("hello")` is unchanged); `%s`, `%d`/`%i`, `%f`, `%j`, `%o`/`%O` and `%c` follow
 * Node's substitution rules for the object cases the console would otherwise hand to `inspect`.
 */
export function formatConsoleArguments(
  values: readonly unknown[],
  profile: TerminalProfile,
): string {
  if (values.length === 0) return "";
  const render = (value: unknown) =>
    typeof value === "string" ? value : profile.inspect(value);

  const first = values[0];
  if (typeof first !== "string" || !first.includes("%")) {
    return values.map(render).join(" ");
  }

  let nextArgument = 1;
  let output = first.replace(/%([sdifjoOc%])/g, (match, specifier: string) => {
    if (specifier === "%") return "%";
    if (nextArgument >= values.length) return match;
    const argument = values[nextArgument];
    nextArgument += 1;
    switch (specifier) {
      case "s":
        return String(argument);
      case "d":
        try {
          return typeof argument === "bigint"
            ? `${argument}n`
            : String(Number(argument));
        } catch {
          return "NaN";
        }
      case "i":
        try {
          return typeof argument === "bigint"
            ? `${argument}n`
            : String(Number.parseInt(String(argument), 10));
        } catch {
          return "NaN";
        }
      case "f":
        try {
          return String(parseFloat(String(argument)));
        } catch {
          return "NaN";
        }
      case "j":
        try {
          return JSON.stringify(argument) ?? String(argument);
        } catch {
          return "[Circular]";
        }
      case "o":
      case "O":
        return profile.inspect(argument);
      case "c":
        return "";
      default:
        return match;
    }
  });

  for (; nextArgument < values.length; nextArgument += 1) {
    output += ` ${render(values[nextArgument])}`;
  }
  return output;
}

/**
 * Apply a profile to the host's global console so native `console.log()` / `console.dir()` obey the
 * profile's depth, sort/compact flags and truncation limits, and restore everything on scope exit:
 *
 * ```ts
 * using _host = applyProfileToHost(profile);
 * console.log(nestedObject); // profile depth, not bunfig depth
 * ```
 *
 * Bun 1.4.4 has no `Bun.inspect.defaults`; this function patches `console` methods and `Bun.inspect`
 * itself. That is process-global state: do not overlap two sessions with different profiles.
 */
export function applyProfileToHost(profile: TerminalProfile): Disposable {
  const consoleMutable = console as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  const consoleMethods = [
    "log",
    "info",
    "debug",
    "warn",
    "error",
    "dir",
  ] as const;
  const saved: Array<{
    name: string;
    original: (...args: unknown[]) => void;
    patched: (...args: unknown[]) => void;
  }> = [];

  for (const name of consoleMethods) {
    const original = consoleMutable[name];
    if (typeof original !== "function") continue;

    let patched: (...args: unknown[]) => void;
    if (name === "dir") {
      patched = (value?: unknown, options?: unknown) => {
        const resolved = resolveInspectOptions(profile, options);
        const prepared = applyInspectLimits(
          value,
          resolved.maxArrayLength,
          resolved.maxStringLength,
        );
        const passthrough =
          options !== null && typeof options === "object"
            ? { ...(options as Record<string, unknown>) }
            : {};
        passthrough.depth = resolved.consoleDepth;
        passthrough.colors = resolved.colors;
        passthrough.sorted = resolved.sorted;
        passthrough.compact = resolved.compact;
        delete passthrough.maxArrayLength;
        delete passthrough.maxStringLength;
        original.call(consoleMutable, prepared, passthrough);
      };
    } else {
      patched = (...values: unknown[]) => {
        original.call(consoleMutable, formatConsoleArguments(values, profile));
      };
    }

    consoleMutable[name] = patched;
    saved.push({ name, original, patched });
  }

  const bunMutable = Bun as unknown as { inspect: typeof Bun.inspect };
  const originalInspect = bunMutable.inspect;
  const inspectDescriptor = Object.getOwnPropertyDescriptor(Bun, "inspect");
  let patchedInspect: typeof Bun.inspect | null = null;

  if (inspectDescriptor?.writable) {
    const wrapper = ((
      value: unknown,
      options?: Parameters<typeof Bun.inspect>[1],
    ): string => {
      const resolved = resolveInspectOptions(profile, options);
      const prepared = applyInspectLimits(
        value,
        resolved.maxArrayLength,
        resolved.maxStringLength,
      );
      return originalInspect(prepared, {
        depth: resolved.consoleDepth,
        colors: resolved.colors,
        sorted: resolved.sorted,
        compact: resolved.compact,
      });
    }) as typeof Bun.inspect;

    Object.defineProperty(wrapper, "custom", {
      value: originalInspect.custom,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(wrapper, "table", {
      value: originalInspect.table,
      enumerable: true,
      configurable: true,
    });

    patchedInspect = wrapper;
    bunMutable.inspect = wrapper;
  }

  let disposed = false;
  return {
    [Symbol.dispose](): void {
      if (disposed) return;
      disposed = true;
      for (const entry of saved) {
        if (consoleMutable[entry.name] === entry.patched) {
          consoleMutable[entry.name] = entry.original;
        }
      }
      if (patchedInspect !== null && bunMutable.inspect === patchedInspect) {
        bunMutable.inspect = originalInspect;
      }
    },
  };
}

/**
 * Resolve a terminal profile using precedence:
 * explicit overrides -> `PTY_*` env vars -> SQLite store -> builtin preset -> builtin default.
 *
 * Invalid explicit overrides throw; invalid environment or stored values are skipped with a warning
 * so a long-running manager degrades to a usable profile instead of failing to start.
 */
export function resolveTerminalProfile(opts?: {
  profile?: string | undefined;
  store?: NamedColorTokenStore | undefined;
  env?: Record<string, string | undefined> | undefined;
  overrides?: Partial<Record<ThemeRole, string>> | undefined;
  consoleDepth?: number | undefined;
  inspectOverrides?: Partial<ProfileInspectSettings> | undefined;
  isTTY?: boolean | undefined;
}): TerminalProfile {
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") mergedEnv[key] = value;
  }
  if (opts?.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) delete mergedEnv[key];
      else mergedEnv[key] = value;
    }
  }

  const profileName =
    opts?.profile?.trim() || mergedEnv.PTY_PROFILE?.trim() || "default";
  const isTTY = opts?.isTTY ?? Boolean(process.stdout.isTTY);
  const depth = detectColorDepth(mergedEnv, isTTY);
  const ansiFormat = depthToAnsiFormat(depth);

  const dbMap = opts?.store ? opts.store.getProfileMap(profileName) : {};
  const dbInspect = opts?.store
    ? opts.store.getInspectSettings(profileName)
    : null;
  const builtin = BUILTIN_PROFILES[profileName];
  const fallback = BUILTIN_PROFILES.default!;
  const warnings: string[] = [];

  if (!builtin && Object.keys(dbMap).length === 0 && dbInspect === null) {
    warnings.push(
      `Unknown profile "${profileName}"; falling back to the builtin "default" preset.`,
    );
  }

  const builtinColors = builtin?.colors ?? fallback.colors;
  const builtinInspect = builtin?.inspect ?? fallback.inspect;

  const pickRole = (role: ThemeRole): DerivedColorToken | null => {
    const explicit = opts?.overrides?.[role];
    if (explicit !== undefined) {
      const valid = normalizeNamedColor(explicit);
      if (!valid) {
        throw new Error(
          `ERR_COLOR_INVALID: override "${explicit}" for role "${role}" is invalid.`,
        );
      }
      return deriveColorToken(role, valid, ansiFormat);
    }

    const envKey = `PTY_${role.toUpperCase()}`;
    const envValue = mergedEnv[envKey];
    if (envValue !== undefined && envValue !== "") {
      const valid = normalizeNamedColor(envValue);
      if (valid) return deriveColorToken(role, valid, ansiFormat);
      warnings.push(
        `Ignoring invalid ${envKey}="${envValue}" for role "${role}".`,
      );
    }

    const storedValue = dbMap[role];
    if (storedValue !== undefined) {
      const valid = normalizeNamedColor(storedValue);
      if (valid) return deriveColorToken(role, valid, ansiFormat);
      warnings.push(
        `Ignoring invalid stored color "${storedValue}" for role "${role}".`,
      );
    }

    const builtinValue = builtinColors[role];
    if (builtinValue !== undefined) {
      const valid = normalizeNamedColor(builtinValue);
      if (valid) return deriveColorToken(role, valid, ansiFormat);
    }
    return null;
  };

  const pickConsoleDepth = (): number => {
    const explicit = opts?.inspectOverrides?.consoleDepth ?? opts?.consoleDepth;
    if (explicit !== undefined) {
      const normalized = normalizeConsoleDepth(explicit);
      if (normalized === null) {
        throw new Error(
          `ERR_CONSOLE_DEPTH_INVALID: "${String(explicit)}" is invalid.`,
        );
      }
      return normalized;
    }
    const envValue = mergedEnv.PTY_CONSOLE_DEPTH;
    if (envValue !== undefined && envValue !== "") {
      const normalized = normalizeConsoleDepth(envValue);
      if (normalized !== null) return normalized;
      warnings.push(
        `Ignoring invalid PTY_CONSOLE_DEPTH="${envValue}"; using ${dbInspect?.consoleDepth ?? builtinInspect.consoleDepth}.`,
      );
    }
    return dbInspect?.consoleDepth ?? builtinInspect.consoleDepth;
  };

  const pickBoolean = (
    explicit: boolean | undefined,
    envKey: string,
    stored: boolean | undefined,
    builtinValue: boolean,
  ): boolean => {
    if (explicit !== undefined) {
      if (typeof explicit !== "boolean") {
        throw new Error(`ERR_INSPECT_FLAG_INVALID: ${envKey} must be boolean.`);
      }
      return explicit;
    }
    const envValue = mergedEnv[envKey];
    if (envValue !== undefined && envValue !== "") {
      const normalized = normalizeBooleanEnv(envValue);
      if (normalized !== null) return normalized;
      warnings.push(
        `Ignoring invalid ${envKey}="${envValue}"; using ${stored ?? builtinValue}.`,
      );
    }
    return stored ?? builtinValue;
  };

  const pickLength = (
    explicit: number | undefined,
    envKey: string,
    stored: number | undefined,
    builtinValue: number,
  ): number => {
    if (explicit !== undefined) {
      const normalized = normalizeInspectLength(explicit);
      if (normalized === null) {
        throw new Error(`ERR_INSPECT_LENGTH_INVALID: ${envKey} is invalid.`);
      }
      return normalized;
    }
    const envValue = mergedEnv[envKey];
    if (envValue !== undefined && envValue !== "") {
      const normalized = normalizeInspectLength(envValue);
      if (normalized !== null) return normalized;
      warnings.push(
        `Ignoring invalid ${envKey}="${envValue}"; using ${stored ?? builtinValue}.`,
      );
    }
    return stored ?? builtinValue;
  };

  const consoleDepth = pickConsoleDepth();
  const inspectSettings: ProfileInspectSettings = {
    consoleDepth,
    sorted: pickBoolean(
      opts?.inspectOverrides?.sorted,
      "PTY_INSPECT_SORTED",
      dbInspect?.sorted,
      builtinInspect.sorted,
    ),
    compact: pickBoolean(
      opts?.inspectOverrides?.compact,
      "PTY_INSPECT_COMPACT",
      dbInspect?.compact,
      builtinInspect.compact,
    ),
    maxArrayLength: pickLength(
      opts?.inspectOverrides?.maxArrayLength,
      "PTY_MAX_ARRAY_LENGTH",
      dbInspect?.maxArrayLength,
      builtinInspect.maxArrayLength,
    ),
    maxStringLength: pickLength(
      opts?.inspectOverrides?.maxStringLength,
      "PTY_MAX_STRING_LENGTH",
      dbInspect?.maxStringLength,
      builtinInspect.maxStringLength,
    ),
  };

  const tokens: Record<ThemeRole, DerivedColorToken | null> = {
    accent: pickRole("accent"),
    error: pickRole("error"),
    warn: pickRole("warn"),
    info: pickRole("info"),
    muted: pickRole("muted"),
    code: pickRole("code"),
    border: pickRole("border"),
    bg: pickRole("bg"),
    fg: pickRole("fg"),
  };

  const getWidth = () => process.stdout.columns ?? 80;
  const markdownTheme = buildMarkdownAnsiTheme(tokens, depth, getWidth);
  const markdownCallbacks = buildMarkdownRenderCallbacks(
    tokens,
    depth,
    getWidth,
  );
  const renderMarkdown = (markdown: string): string =>
    Bun.markdown.ansi(markdown, markdownTheme);
  const renderMarkdownThemed = (markdown: string): string =>
    Bun.markdown.render(markdown, markdownCallbacks);

  const inspectFn = (value: unknown, overrideDepth?: number): string => {
    let targetDepth = inspectSettings.consoleDepth;
    if (overrideDepth !== undefined) {
      const normalized = normalizeConsoleDepth(overrideDepth);
      if (normalized === null) {
        throw new Error(
          `ERR_CONSOLE_DEPTH_INVALID: override "${String(overrideDepth)}" is invalid.`,
        );
      }
      targetDepth = normalized;
    }
    return inspectValue(
      value,
      { ...inspectSettings, consoleDepth: targetDepth },
      depth !== "none",
    );
  };

  const toEnv = (baseBunOptions = ""): Record<string, string> => {
    const envOut: Record<string, string> = {
      PTY_PROFILE: profileName,
      PTY_COLOR_DEPTH: depth,
      PTY_CONSOLE_DEPTH:
        inspectSettings.consoleDepth === Infinity
          ? "Infinity"
          : String(inspectSettings.consoleDepth),
      PTY_INSPECT_SORTED: inspectSettings.sorted ? "1" : "0",
      PTY_INSPECT_COMPACT: inspectSettings.compact ? "1" : "0",
      PTY_MAX_ARRAY_LENGTH:
        inspectSettings.maxArrayLength === Infinity
          ? "Infinity"
          : String(inspectSettings.maxArrayLength),
      PTY_MAX_STRING_LENGTH:
        inspectSettings.maxStringLength === Infinity
          ? "Infinity"
          : String(inspectSettings.maxStringLength),
    };

    for (const [role, token] of Object.entries(tokens)) {
      if (token) envOut[`PTY_${role.toUpperCase()}`] = token.name;
    }

    // The profile's consoleDepth is authoritative: strip an inherited --console-depth so a stale
    // BUN_OPTIONS value cannot silently override the profile in the child process. Bun 1.4.4 rejects
    // `--console-depth=Infinity`, so an unlimited profile omits the flag (PTY_CONSOLE_DEPTH carries
    // the intent to cooperative children).
    const base = baseBunOptions
      .replace(/(?:^|\s)--console-depth\s+\d+(?=\s|$)/g, " ")
      .replace(/(?:^|\s)--console-depth(?:=\d+)?(?=\s|$)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (Number.isFinite(inspectSettings.consoleDepth)) {
      const flag = `--console-depth=${inspectSettings.consoleDepth}`;
      envOut.BUN_OPTIONS = base ? `${base} ${flag}` : flag;
    } else if (base) {
      envOut.BUN_OPTIONS = base;
    }

    return envOut;
  };

  const profileObject: TerminalProfile = {
    profile: profileName,
    depth,
    consoleDepth: inspectSettings.consoleDepth,
    inspectSettings,
    tokens,
    markdownTheme,
    markdownCallbacks,
    warnings,
    renderMarkdown,
    renderMarkdownThemed,
    renderProfileCard: () => renderProfileCardFor(profileObject),
    inspect: inspectFn,
    log(...values: unknown[]): void {
      console.log(formatConsoleArguments(values, profileObject));
    },
    toEnv,
  };

  Object.defineProperty(profileObject, Bun.inspect.custom, {
    value: profileInspectFormatter(profileObject),
    enumerable: false,
    configurable: true,
  });

  return profileObject;
}

/**
 * Returns a `Bun.inspect.custom` implementation for a profile. Assign it to an object to make
 * `console.log(object)` render the profile card:
 *
 * ```ts
 * Object.defineProperty(target, Bun.inspect.custom, {
 *   value: profileInspectFormatter(profile),
 * });
 * ```
 */
export function profileInspectFormatter(
  profile: TerminalProfile,
): () => string {
  return () => profile.renderProfileCard();
}

function swatchMarker(role: ThemeRole): string {
  const index = THEME_ROLES.indexOf(role);
  return String.fromCodePoint(0xe000 + index).repeat(6);
}

function renderProfileCardFor(profile: TerminalProfile): string {
  const settings = profile.inspectSettings;
  const bunOptions =
    profile.toEnv(Bun.env.BUN_OPTIONS ?? "").BUN_OPTIONS ?? "(none)";
  const profileLabel = profile.profile.replace(/`/g, "\\`");

  const tokenRows = THEME_ROLES.map((role) => {
    const token = profile.tokens[role];
    if (!token) return null;
    const swatch = profile.depth === "none" ? "██████" : swatchMarker(role);
    return `| \`${role}\` | ${swatch} | \`${token.name}\` | \`${token.hex}\` | \`${token.number}\` | \`${token.contrastFgName}\` |`;
  })
    .filter((row): row is string => row !== null)
    .join("\n");

  const warningBlock =
    profile.warnings.length > 0
      ? `\n> **Warning**: ${profile.warnings.join(" ")}\n`
      : "";

  const markdown = [
    `## Terminal profile: \`${profileLabel}\``,
    warningBlock,
    `| Setting | Value |`,
    `| :--- | :--- |`,
    `| Color depth | \`${profile.depth}\` |`,
    `| Console depth | \`${settings.consoleDepth === Infinity ? "∞" : settings.consoleDepth}\` |`,
    `| Sorted keys | \`${settings.sorted}\` |`,
    `| Compact | \`${settings.compact}\` |`,
    `| Max array length | \`${settings.maxArrayLength === Infinity ? "∞" : settings.maxArrayLength}\` |`,
    `| Max string length | \`${settings.maxStringLength === Infinity ? "∞" : settings.maxStringLength}\` |`,
    `| BUN_OPTIONS | \`${bunOptions}\` |`,
    ``,
    `| Role | Swatch | Color | Hex | Number | Contrast |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- |`,
    tokenRows,
  ].join("\n");

  let rendered = profile.renderMarkdown(markdown);

  if (profile.depth !== "none") {
    for (const role of THEME_ROLES) {
      const token = profile.tokens[role];
      if (!token) continue;
      rendered = rendered
        .split(swatchMarker(role))
        .join(`${token.ansiFg}██████\x1b[0m`);
    }
  }

  const sample = {
    level1: {
      level2: {
        level3: {
          level4: {
            level5: { level6: "deepest" },
          },
        },
      },
    },
    list: Array.from({ length: 12 }, (_, index) => index),
    text: "abcdefghijklmnopqrstuvwxyz".repeat(4),
  };
  const sampleHeading = profile.renderMarkdown(
    `### Sample object at consoleDepth ${settings.consoleDepth === Infinity ? "∞" : settings.consoleDepth}\n`,
  );

  return `${rendered}${sampleHeading}${profile.inspect(sample)}\n`;
}

/**
 * Probe PTY allocation. `Bun.Terminal` can exist as a constructor yet fail to open `/dev/ptmx`
 * (sandboxes and locked-down hosts); callers should skip interactive work rather than report a
 * crash as a terminal failure.
 */
export function probePtySupport(): {
  available: boolean;
  error: string | null;
} {
  if (typeof Bun.Terminal !== "function") {
    return {
      available: false,
      error: "Bun.Terminal is not implemented in this build.",
    };
  }
  try {
    new Bun.Terminal({ cols: 80, rows: 24 }).close();
    return { available: true, error: null };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isPtyAvailable(): boolean {
  return probePtySupport().available;
}

// ============================================================================
// 6. createProfiledTerminal (low-level Bun.Terminal + Blob wrapper)
// ============================================================================

export function createProfiledTerminal(
  profile: TerminalProfile,
  opts?: CreateProfiledTerminalOptions,
): ProfiledTerminalHandle {
  if (typeof Bun.Terminal !== "function") {
    throw new Error(
      "ERR_PTY_UNSUPPORTED: this Bun build has no Bun.Terminal implementation.",
    );
  }

  const chunks: Uint8Array[] = [];
  const passthrough = opts?.passthroughStdout ?? Boolean(process.stdout.isTTY);

  const terminal = new Bun.Terminal({
    cols: opts?.cols ?? process.stdout.columns ?? 80,
    rows: opts?.rows ?? process.stdout.rows ?? 24,
    name: profile.depth === "none" ? "xterm" : "xterm-256color",
    data(_terminal, data) {
      chunks.push(new Uint8Array(data));
      if (passthrough) process.stdout.write(data);
      opts?.onData?.(terminal, data);
    },
    exit(term, exitCode, signal) {
      opts?.onExit?.(term, exitCode, signal);
    },
    drain(term) {
      opts?.onDrain?.(term);
    },
  });

  return {
    terminal,
    profile,
    async write(input: TerminalInput | Blob): Promise<number> {
      if (terminal.closed) return 0;
      if (input instanceof Blob) {
        return terminal.write(await input.bytes());
      }
      return terminal.write(input);
    },
    toBlob(): Blob {
      return new Blob(chunks, { type: "application/octet-stream" });
    },
    async toCleanTextBlob(): Promise<Blob> {
      const raw = await new Blob(chunks).text();
      return new Blob([Bun.stripANSI(raw)], {
        type: "text/plain;charset=utf-8",
      });
    },
  };
}

// ============================================================================
// 7. runProfiledPtySession (full lifecycle PTY runner)
// ============================================================================

function resolveExecutable(
  command: string,
  cwd: string | undefined,
  path: string | undefined,
): string | null {
  if (command.includes("/") || command.includes("\\")) {
    const absolute = isAbsolute(command)
      ? command
      : resolvePath(cwd ?? process.cwd(), command);
    try {
      accessSync(absolute, fsConstants.X_OK);
      return absolute;
    } catch {
      return null;
    }
  }
  const whichOptions: { cwd?: string; PATH?: string } = {};
  if (cwd !== undefined) whichOptions.cwd = cwd;
  if (path !== undefined) whichOptions.PATH = path;
  return Bun.which(command, whichOptions);
}

export async function runProfiledPtySession(
  opts: ProfiledPtySessionOptions,
): Promise<ProfiledPtySessionResult> {
  if (typeof Bun.Terminal !== "function") {
    throw new Error(
      "ERR_PTY_UNSUPPORTED: this Bun build has no Bun.Terminal implementation.",
    );
  }
  if (!opts.cmd?.[0]) {
    throw new Error(
      "ERR_PTY_INVALID_CMD: cmd must contain at least an executable name.",
    );
  }
  if (opts.signal?.aborted) {
    throw new Error(
      "ERR_PTY_ABORTED: AbortSignal was already aborted prior to spawn.",
    );
  }

  const startedAt = performance.now();
  const interactive =
    opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const profile =
    opts.profile ??
    resolveTerminalProfile({
      profile: opts.profileName,
      store: opts.store,
      env: opts.env,
      overrides: opts.roleOverrides,
      consoleDepth: opts.consoleDepthOverride,
      inspectOverrides: opts.inspectOverrides,
      isTTY: interactive || Boolean(process.stdout.isTTY),
    });

  using _hostInspectGuard =
    (opts.syncHostInspectDefaults ?? true)
      ? applyProfileToHost(profile)
      : undefined;

  const existingBunOptions =
    opts.env?.BUN_OPTIONS ?? process.env.BUN_OPTIONS ?? "";
  const profileEnv = profile.toEnv(existingBunOptions);

  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") mergedEnv[key] = value;
  }
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) delete mergedEnv[key];
      else mergedEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(profileEnv)) {
    mergedEnv[key] = value;
  }

  const cols = opts.cols ?? process.stdout.columns ?? 80;
  const rows = opts.rows ?? process.stdout.rows ?? 24;
  mergedEnv.COLUMNS = String(cols);
  mergedEnv.LINES = String(rows);

  if (profile.depth === "none") {
    mergedEnv.NO_COLOR = "1";
    mergedEnv.FORCE_COLOR = "0";
    delete mergedEnv.COLORTERM;
    mergedEnv.TERM ??= "xterm";
  } else if (profile.depth === "truecolor") {
    delete mergedEnv.NO_COLOR;
    mergedEnv.TERM ??= "xterm-256color";
    mergedEnv.COLORTERM = "truecolor";
    mergedEnv.FORCE_COLOR = "3";
  } else if (profile.depth === "ansi256") {
    delete mergedEnv.NO_COLOR;
    mergedEnv.TERM = "xterm-256color";
    delete mergedEnv.COLORTERM;
    mergedEnv.FORCE_COLOR = "2";
  } else {
    delete mergedEnv.NO_COLOR;
    mergedEnv.TERM ??= "xterm";
    delete mergedEnv.COLORTERM;
    mergedEnv.FORCE_COLOR = "1";
  }

  const resolvedBin = resolveExecutable(opts.cmd[0], opts.cwd, mergedEnv.PATH);
  if (!resolvedBin) {
    throw new Error(
      `ERR_PTY_NOT_FOUND: Executable "${opts.cmd[0]}" not found in PATH.`,
    );
  }

  const wasRaw = Boolean(process.stdin.isTTY && process.stdin.isRaw);
  const stdinWasPaused =
    typeof process.stdin.isPaused === "function"
      ? process.stdin.isPaused()
      : true;
  const maxCapture = Math.max(
    0,
    Math.trunc(opts.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES),
  );
  const captureDecoder = new TextDecoder("utf-8", { fatal: false });
  const streamDecoder = new TextDecoder("utf-8", { fatal: false });

  let capturedBytes = 0;
  let captureTruncated = false;
  const capturedTextChunks: string[] = [];
  const capturedRawChunks: Uint8Array<ArrayBuffer>[] = [];
  let fenceBuffer = "";
  let termClosed = false;
  let timedOut: "wall" | "idle" | null = null;
  let aborted = false;
  let proc: Bun.Subprocess | undefined;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const escalateKill = (reason: "wall" | "idle" | "abort") => {
    if (!proc || proc.exitCode !== null) return;
    if (reason === "wall" || reason === "idle") timedOut = reason;
    else aborted = true;

    proc.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (proc && proc.exitCode === null) proc.kill("SIGKILL");
    }, 1_500);
    killTimer.unref();
  };

  const resetIdleWatchdog = () => {
    if (!opts.idleTimeoutMs || opts.idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => escalateKill("idle"), opts.idleTimeoutMs);
    idleTimer.unref();
  };

  const emitOutputChunk = (chunk: Uint8Array) => {
    opts.onData?.(chunk);
    if (!interactive) return;

    if (!opts.renderChildMarkdownBlocks) {
      process.stdout.write(chunk);
      return;
    }

    fenceBuffer += streamDecoder.decode(chunk, { stream: true });
    MARKDOWN_FENCE_RE.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = MARKDOWN_FENCE_RE.exec(fenceBuffer)) !== null) {
      if (match.index > lastIndex) {
        process.stdout.write(fenceBuffer.slice(lastIndex, match.index));
      }
      const rendered = profile.renderMarkdown(match[1]!).replace(/\n/g, "\r\n");
      process.stdout.write(rendered);
      lastIndex = MARKDOWN_FENCE_RE.lastIndex;
    }

    const remainder = fenceBuffer.slice(lastIndex);
    const openIndex = remainder.indexOf(":::md");
    if (openIndex !== -1) {
      if (openIndex > 0) process.stdout.write(remainder.slice(0, openIndex));
      fenceBuffer = remainder.slice(openIndex);
    } else {
      process.stdout.write(remainder);
      fenceBuffer = "";
    }
  };

  const term = new Bun.Terminal({
    cols,
    rows,
    name: mergedEnv.TERM,
    data(_terminal, data) {
      resetIdleWatchdog();
      emitOutputChunk(data);

      if (opts.captureOutput && capturedBytes < maxCapture) {
        const remaining = maxCapture - capturedBytes;
        const slice =
          data.byteLength <= remaining ? data : data.subarray(0, remaining);
        if (slice.byteLength < data.byteLength) captureTruncated = true;
        capturedBytes += slice.byteLength;
        const copy = new Uint8Array(slice);
        capturedRawChunks.push(copy);
        capturedTextChunks.push(captureDecoder.decode(copy, { stream: true }));
      } else if (opts.captureOutput && data.byteLength > 0) {
        captureTruncated = true;
      }
    },
    drain() {
      // Bun.Terminal buffers writes internally; drain only signals readiness.
    },
    exit() {
      termClosed = true;
    },
  });

  const onResize = () => {
    if (!term.closed && process.stdout.columns && process.stdout.rows) {
      term.resize(process.stdout.columns, process.stdout.rows);
    }
  };
  const onSigInt = () => proc?.exitCode === null && proc.kill("SIGINT");
  const onSigTerm = () => proc?.exitCode === null && proc.kill("SIGTERM");
  const onSigHup = () => proc?.exitCode === null && proc.kill("SIGHUP");
  const onSigCont = () => {
    if (interactive && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      } catch {
        // A non-raw stdin is still usable; do not fail the session on resume.
      }
    }
    onResize();
  };
  const onStdin = (chunk: Uint8Array) => {
    if (!term.closed) term.write(chunk);
  };
  const onAbort = () => escalateKill("abort");

  let abnormal = false;

  try {
    if (interactive && process.stdout.isTTY && profile.depth !== "none") {
      if (profile.tokens.fg) process.stdout.write(profile.tokens.fg.osc10);
      if (profile.tokens.bg) process.stdout.write(profile.tokens.bg.osc11);
    }

    if (opts.bannerMarkdown && interactive) {
      process.stdout.write(
        profile.renderMarkdown(opts.bannerMarkdown).replace(/\n/g, "\r\n"),
      );
    }

    proc = Bun.spawn([resolvedBin, ...opts.cmd.slice(1)], {
      cwd: opts.cwd ?? process.cwd(),
      env: mergedEnv,
      terminal: term,
    });

    if (interactive) {
      process.stdin.resume();
      process.stdin.on("data", onStdin);
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(true);
        } catch {
          // PTY still receives data without raw mode.
        }
      }
    }

    if (interactive) process.stdout.on("resize", onResize);
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    process.on("SIGHUP", onSigHup);
    process.on("SIGCONT", onSigCont);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      wallTimer = setTimeout(() => escalateKill("wall"), opts.timeoutMs);
      wallTimer.unref();
    }
    resetIdleWatchdog();

    const rawExit = await proc.exited;
    const sig = (proc.signalCode as NodeJS.Signals | null) ?? null;
    if (sig || timedOut || aborted) abnormal = true;

    if (interactive && opts.renderChildMarkdownBlocks) {
      fenceBuffer += streamDecoder.decode();
      if (fenceBuffer) process.stdout.write(fenceBuffer);
      fenceBuffer = "";
    }

    if (opts.captureOutput) {
      capturedTextChunks.push(captureDecoder.decode());
    }

    const signalNumbers = osConstants.signals as Record<
      string,
      number | undefined
    >;
    const signalNumber = sig ? signalNumbers[sig] : undefined;
    const exitCode = signalNumber !== undefined ? 128 + signalNumber : rawExit;
    const durationMs = Math.round(performance.now() - startedAt);

    if (opts.footerMarkdown && interactive) {
      const footer = opts.footerMarkdown({ exitCode, durationMs });
      process.stdout.write(
        profile.renderMarkdown(footer).replace(/\n/g, "\r\n"),
      );
    }

    const rawOutput = opts.captureOutput ? capturedTextChunks.join("") : "";
    return {
      exitCode,
      signal: sig,
      timedOut,
      aborted,
      durationMs,
      profile: profile.profile,
      colorDepth: profile.depth,
      consoleDepth: profile.consoleDepth,
      rawOutput,
      cleanOutput: opts.captureOutput ? Bun.stripANSI(rawOutput) : "",
      captureTruncated,
      transcriptBlob: new Blob(capturedRawChunks, {
        type: "application/octet-stream",
      }),
    };
  } catch (error) {
    abnormal = true;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ERR_PTY_EXEC: "${opts.cmd.join(" ")}" failed: ${message}`,
      { cause: error },
    );
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (killTimer) clearTimeout(killTimer);

    if (interactive) process.stdout.off("resize", onResize);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("SIGHUP", onSigHup);
    process.off("SIGCONT", onSigCont);
    process.stdin.off("data", onStdin);
    opts.signal?.removeEventListener("abort", onAbort);

    if (interactive) {
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(wasRaw);
        } catch {
          // Best effort: the terminal may already be gone.
        }
      }
      if (!wasRaw && stdinWasPaused) process.stdin.pause();
      if (profile.tokens.fg) process.stdout.write("\x1b]110\x07");
      if (profile.tokens.bg) process.stdout.write("\x1b]111\x07");
      if (abnormal && (opts.restoreScreenOnAbort ?? true)) {
        process.stdout.write(RESET_TERMINAL_SEQ);
      }
    }

    if (!termClosed && !term.closed) {
      try {
        term.close();
      } catch {
        // Already closed by the child exit path.
      }
    }
  }
}
