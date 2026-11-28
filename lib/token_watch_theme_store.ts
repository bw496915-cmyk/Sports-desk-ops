/**
 * @file lib/token_watch_theme_store.ts
 * @description Deterministic SQLite colour UDFs and hook-driven sync serialization for the
 * `profile_themes` registry.
 *
 * `Bun.color()` stays the only colour parser: the UDFs expose its canonical 24-bit integer and
 * CSS value inside SQL, so an INSERT cannot store a colour the renderers would reject. SQLite
 * update hooks fire while the writing connection still owns the statement, so a sync triggered
 * from `onInsert`/`onUpdate`/`onDelete` yields once before it queries the database again; the
 * running+dirty loop then coalesces a burst of writes into one serialized run.
 */
import type { Database } from "bun:sqlite";
import {
  syncIfChanged,
  type SyncState,
  type SyncTargets,
} from "./token_watch_daemon.ts";

const COLOR_INT_FUNCTION = "bun_color_int";
const COLOR_CSS_FUNCTION = "bun_color_css";

/** Natural language for the argument when ERR_COLOR_INVALID has to name it. */
function describeColorArgument(input: unknown): string {
  if (typeof input === "string") return JSON.stringify(input);
  return String(input);
}

/**
 * Canonical 24-bit integer and CSS value for one SQL colour argument.
 *
 * `Bun.color()` answers NULL for invalid text instead of throwing, so both parses are checked
 * explicitly and every rejection is the same `ERR_COLOR_INVALID` error. SQL NULL reaches the
 * callback as `null`; with `safeIntegers` an INTEGER argument arrives as a `bigint`.
 */
function parseColorArgument(input: unknown): {
  readonly colorInt: number;
  readonly colorCss: string;
} {
  let normalized: string | number | null = null;
  if (typeof input === "string") normalized = input;
  else if (typeof input === "number") normalized = input;
  else if (typeof input === "bigint") normalized = Number(input);

  const colorInt = normalized === null ? null : Bun.color(normalized, "number");
  const colorCss = normalized === null ? null : Bun.color(normalized, "css");
  if (colorInt === null || colorCss === null) {
    throw new Error(
      `ERR_COLOR_INVALID: ${describeColorArgument(input)} failed Bun.color validation.`,
    );
  }
  return { colorInt, colorCss };
}

/**
 * Register the deterministic colour UDFs on `db`.
 *
 * The options object must come BEFORE the callback: `db.function(name, fn, options)` is
 * accepted on Bun 1.4.4 but registers with flags 0, leaving SQLITE_DETERMINISTIC clear
 * (measured on the pin: options-first sets bit 0x800, options-last does not).
 */
export function registerColorUdfs(db: Database): void {
  db.function(
    COLOR_INT_FUNCTION,
    { deterministic: true },
    (input: unknown) => parseColorArgument(input).colorInt,
  );
  db.function(
    COLOR_CSS_FUNCTION,
    { deterministic: true },
    (input: unknown) => parseColorArgument(input).colorCss,
  );
}

/** Injection points for tests and callers that own their sync step. */
export interface ThemeSyncOptions {
  readonly sync?: (
    db: Database,
    state: SyncState,
    targets: SyncTargets,
  ) => Promise<boolean>;
  readonly onError?: (error: unknown) => void;
}

import { createStateMachine, defineStateGraph } from "./state_machine.ts";

export const THEME_SYNC_STATES = [
  "idle",
  "syncing_clean",
  "syncing_dirty",
  "stopped",
] as const;
export type ThemeSyncStateKind = (typeof THEME_SYNC_STATES)[number];

export const THEME_SYNC_GRAPH = defineStateGraph(
  "ThemeSyncController",
  THEME_SYNC_STATES,
  {
    idle: ["syncing_dirty", "stopped"],
    syncing_clean: ["syncing_dirty", "idle", "stopped"],
    syncing_dirty: ["syncing_clean", "syncing_dirty", "idle", "stopped"],
    stopped: [],
  },
);

type ThemeSyncSnapshot =
  | { readonly kind: "idle"; readonly lastRun: Promise<void> | null }
  | { readonly kind: "syncing_clean"; readonly flight: Promise<void> }
  | { readonly kind: "syncing_dirty"; readonly flight: Promise<void> }
  | { readonly kind: "stopped"; readonly lastRun: Promise<void> | null };

export interface ThemeSyncController {
  readonly state?: ThemeSyncStateKind;
  readonly trigger: () => void;
  idle(): Promise<void>;
  stop(): void;
  readonly syncs: number;
}

/** One controller per connection: attaching twice would silently replace the hooks. */
const attachedDatabases = new WeakSet<Database>();

type HookErrorCode = "ERR_THEME_HOOKS_ATTACHED" | "ERR_THEME_HOOKS_FOREIGN";

function hookError(
  code: HookErrorCode,
  message: string,
): Error & { code: HookErrorCode } {
  const error = new Error(`${code}: ${message}`) as Error & {
    code: HookErrorCode;
  };
  error.code = code;
  return error;
}

function attachedError(): Error & { code: "ERR_THEME_HOOKS_ATTACHED" } {
  return hookError(
    "ERR_THEME_HOOKS_ATTACHED",
    "a theme sync controller is already attached to this database",
  ) as Error & { code: "ERR_THEME_HOOKS_ATTACHED" };
}

function foreignHookError(): Error & { code: "ERR_THEME_HOOKS_FOREIGN" } {
  return hookError(
    "ERR_THEME_HOOKS_FOREIGN",
    "another onInsert/onUpdate/onDelete hook is already attached",
  ) as Error & { code: "ERR_THEME_HOOKS_FOREIGN" };
}

/**
 * Attach `onInsert`/`onUpdate`/`onDelete` hooks that run `sync` serially for writes to
 * `profile_themes`.
 *
 * A trigger transitions `idle -> syncing_dirty` (or `syncing_clean -> syncing_dirty` while a sync
 * is already in flight), so a burst of writes coalesces instead of stacking. The default sync is
 * `syncIfChanged`, which fingerprints the snapshot before rewriting `.env`, `.env.example` and
 * the generated theme LUT. A rejecting sync rejects `idle()` (and reaches `onError`), leaves
 * `syncs` unchanged and transitions back to `idle` so the next write can start a fresh run.
 */
export function attachThemeSyncHooks(
  db: Database,
  state: SyncState,
  targets: SyncTargets,
  options: ThemeSyncOptions = {},
): ThemeSyncController {
  if (attachedDatabases.has(db)) throw attachedError();
  if (db.onInsert !== null || db.onUpdate !== null || db.onDelete !== null) {
    throw foreignHookError();
  }

  const sync = options.sync ?? syncIfChanged;
  const onError = options.onError;
  let syncs = 0;

  const machine = createStateMachine<ThemeSyncSnapshot>({
    graph: THEME_SYNC_GRAPH,
    initial: { kind: "idle", lastRun: null },
  });

  const startRun = (): void => {
    let runPromise!: Promise<void>;
    runPromise = (async (): Promise<void> => {
      // The hook runs while the writer's statement still holds the connection; querying from
      // that stack throws "This database connection is busy executing a query". Yield once so
      // the first sync starts after the write call stack unwinds.
      await Promise.resolve();
      try {
        while (machine.kind === "syncing_dirty") {
          machine.transition(
            { kind: "syncing_clean", flight: runPromise },
            "pass_start",
          );
          await sync(db, state, targets);
          syncs += 1;
        }
      } catch (error) {
        onError?.(error);
        throw error;
      } finally {
        if (
          machine.kind === "syncing_clean" ||
          machine.kind === "syncing_dirty"
        ) {
          machine.transition({ kind: "idle", lastRun: runPromise }, "settled");
        }
      }
    })();
    // idle() observers receive the rejection; this handler only keeps an unobserved failure
    // from surfacing as an unhandled rejection when nobody awaits idle().
    runPromise.catch(() => {});
    machine.transition(
      { kind: "syncing_dirty", flight: runPromise },
      "trigger_from_idle",
    );
  };

  const trigger = (): void => {
    const snap = machine.state;
    switch (snap.kind) {
      case "stopped":
      case "syncing_dirty":
        return;
      case "syncing_clean":
        machine.transition(
          { kind: "syncing_dirty", flight: snap.flight },
          "coalesce_dirty",
        );
        return;
      case "idle":
        startRun();
        return;
    }
  };

  const hook = (
    _database: Database,
    tableName: string,
    _rowid: number | bigint,
    _schemaName: string,
  ): void => {
    if (tableName !== "profile_themes") return;
    trigger();
  };

  const stop = (): void => {
    const snap = machine.state;
    if (snap.kind === "stopped") return;
    const lastRun =
      snap.kind === "syncing_clean" || snap.kind === "syncing_dirty"
        ? snap.flight
        : snap.lastRun;
    machine.transition({ kind: "stopped", lastRun }, "stop");
    attachedDatabases.delete(db);
    if (db.onInsert === hook) db.onInsert = null;
    if (db.onUpdate === hook) db.onUpdate = null;
    if (db.onDelete === hook) db.onDelete = null;
  };

  db.onInsert = hook;
  db.onUpdate = hook;
  db.onDelete = hook;
  attachedDatabases.add(db);

  return {
    get state() {
      return machine.kind;
    },
    trigger,
    idle: () => {
      const snap = machine.state;
      switch (snap.kind) {
        case "syncing_clean":
        case "syncing_dirty":
          return snap.flight;
        case "idle":
        case "stopped":
          return snap.lastRun ?? Promise.resolve();
      }
    },
    stop,
    get syncs() {
      return syncs;
    },
  };
}
