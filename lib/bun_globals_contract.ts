/**
 * @file lib/bun_globals_contract.ts
 * @description The documented Bun globals table, checked against the runtime.
 *
 * bun.com/reference/globals is a table, not a contract. It omits globals this
 * repository depends on (`Temporal` in `lib/desk-parser.ts`) and globals the
 * runtime exposes anyway (`URLPattern`, which `lib/api_base_validate.ts` now
 * imports from `node:url` as the same constructor), and it lists five CommonJS
 * module bindings under a "Globals" heading. This module keeps both facts
 * executable: the documented set is data, and `globalsContract()` reports where
 * the runtime disagrees.
 *
 * Measured on Bun 1.4.5 (the repo pin). The undocumented surface lists were
 * collected by diffing `Object.getOwnPropertyNames(globalThis)` against the
 * reference table, so they are a recorded observation, not a completeness claim:
 * ECMAScript built-ins are deliberately excluded.
 *
 * The diff is execution-mode-scoped. `bun -e` also exposes Node builtin modules
 * as globals (`fs`, `path`, `os`, ...), while `bun file.ts` and `bun test` do not
 * (measured on 1.4.5), so those are not part of this contract. Node *globals*
 * (`Buffer`, `process`, `global`) are present in every mode.
 */

export type GlobalSource = "web" | "node" | "bun" | "cloudflare" | "cross";

export interface DocumentedGlobal {
  readonly name: string;
  readonly source: GlobalSource;
  /** Reachable as a CommonJS module binding, not as a property of `globalThis`. */
  readonly moduleScoped?: boolean;
}

/** bun.com/reference/globals, transcribed in table order. */
export const DOCUMENTED_GLOBALS: readonly DocumentedGlobal[] = [
  { name: "AbortController", source: "web" },
  { name: "AbortSignal", source: "web" },
  { name: "alert", source: "web" },
  { name: "Blob", source: "web" },
  { name: "Buffer", source: "node" },
  { name: "Bun", source: "bun" },
  { name: "ByteLengthQueuingStrategy", source: "web" },
  { name: "confirm", source: "web" },
  { name: "__dirname", source: "node", moduleScoped: true },
  { name: "__filename", source: "node", moduleScoped: true },
  { name: "atob", source: "web" },
  { name: "btoa", source: "web" },
  { name: "BuildMessage", source: "bun" },
  { name: "clearImmediate", source: "web" },
  { name: "clearInterval", source: "web" },
  { name: "clearTimeout", source: "web" },
  { name: "console", source: "web" },
  { name: "CountQueuingStrategy", source: "web" },
  { name: "Crypto", source: "web" },
  { name: "crypto", source: "web" },
  { name: "CryptoKey", source: "web" },
  { name: "CustomEvent", source: "web" },
  { name: "Event", source: "web" },
  { name: "EventTarget", source: "web" },
  { name: "exports", source: "node", moduleScoped: true },
  { name: "fetch", source: "web" },
  { name: "FormData", source: "web" },
  { name: "global", source: "node" },
  { name: "globalThis", source: "cross" },
  { name: "Headers", source: "web" },
  { name: "HTMLRewriter", source: "cloudflare" },
  { name: "JSON", source: "cross" },
  { name: "MessageEvent", source: "web" },
  { name: "module", source: "node", moduleScoped: true },
  { name: "performance", source: "web" },
  { name: "process", source: "node" },
  { name: "prompt", source: "web" },
  { name: "queueMicrotask", source: "web" },
  { name: "ReadableByteStreamController", source: "web" },
  { name: "ReadableStream", source: "web" },
  { name: "ReadableStreamDefaultController", source: "web" },
  { name: "ReadableStreamDefaultReader", source: "web" },
  { name: "reportError", source: "web" },
  { name: "require", source: "node", moduleScoped: true },
  { name: "ResolveMessage", source: "bun" },
  { name: "Response", source: "web" },
  { name: "Request", source: "web" },
  { name: "setImmediate", source: "web" },
  { name: "setInterval", source: "web" },
  { name: "setTimeout", source: "web" },
  { name: "ShadowRealm", source: "cross" },
  { name: "SubtleCrypto", source: "web" },
  { name: "DOMException", source: "web" },
  { name: "TextDecoder", source: "web" },
  { name: "TextEncoder", source: "web" },
  { name: "TransformStream", source: "web" },
  { name: "TransformStreamDefaultController", source: "web" },
  { name: "URL", source: "web" },
  { name: "URLSearchParams", source: "web" },
  { name: "WebAssembly", source: "web" },
  { name: "WritableStream", source: "web" },
  { name: "WritableStreamDefaultController", source: "web" },
  { name: "WritableStreamDefaultWriter", source: "web" },
];

/** Documented globals that are really CommonJS module bindings. */
export const MODULE_SCOPED_GLOBALS: readonly string[] =
  DOCUMENTED_GLOBALS.filter((entry) => entry.moduleScoped === true).map(
    (entry) => entry.name,
  );

/**
 * Runtime globals the reference table does not list. `Temporal` is the one this
 * repository calls as a global, and it is also why `tsc@5.9.3` reports 29 errors
 * that `bun check` does not. `URLPattern` stays here because the runtime global
 * exists even though the documented `node:url` export is the better import.
 */
export const UNDOCUMENTED_WEB_SURFACE: readonly string[] = [
  "URLPattern",
  "Temporal",
  "WebSocket",
  "structuredClone",
  "navigator",
  "self",
  "Worker",
  "File",
  "MessageChannel",
  "MessagePort",
  "BroadcastChannel",
  "CompressionStream",
  "DecompressionStream",
  "TextDecoderStream",
  "TextEncoderStream",
  "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest",
  "Performance",
  "PerformanceEntry",
  "PerformanceMark",
  "PerformanceMeasure",
  "PerformanceObserver",
  "PerformanceObserverEntryList",
  "PerformanceResourceTiming",
  "PerformanceServerTiming",
  "PerformanceTiming",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "postMessage",
  "onerror",
  "onmessage",
];

export interface GlobalsContract {
  /** Documented, non-module-scoped, and present on the scope. */
  readonly documentedPresent: readonly string[];
  /** Documented as a global but absent from the scope. */
  readonly documentedAbsent: readonly string[];
  /** Documented, module-scoped, and absent from the scope (expected). */
  readonly moduleScopedOnly: readonly string[];
  /** Undocumented web/Bun surface present on the scope. */
  readonly undocumentedWeb: readonly string[];
}

/**
 * Compare the documented table with a global scope. Pure: pass `{}` to see the
 * documented set on its own, or the default `globalThis` for the runtime.
 */
export function globalsContract(scope: object = globalThis): GlobalsContract {
  const present = (name: string): boolean => name in scope;
  const names = (
    entries: readonly DocumentedGlobal[],
    keep: (entry: DocumentedGlobal) => boolean,
  ): readonly string[] => entries.filter(keep).map((entry) => entry.name);

  return {
    documentedPresent: names(
      DOCUMENTED_GLOBALS,
      (entry) => entry.moduleScoped !== true && present(entry.name),
    ),
    documentedAbsent: names(
      DOCUMENTED_GLOBALS,
      (entry) => entry.moduleScoped !== true && !present(entry.name),
    ),
    moduleScopedOnly: names(
      DOCUMENTED_GLOBALS,
      (entry) => entry.moduleScoped === true && !present(entry.name),
    ),
    undocumentedWeb: UNDOCUMENTED_WEB_SURFACE.filter(present),
  };
}

/**
 * Node reference entries that are declaration-only. The docs page exists, but
 * neither the pinned Bun nor the local Node exports a value, so `new ModuleSource(...)`
 * fails at the call site rather than at import (a named ESM import silently yields
 * `undefined`). Keep this list small and measured: the contract test fails the day
 * the runtime ships one.
 */
export interface NodeTypeOnlyExport {
  readonly module: string;
  readonly name: string;
}

export const NODE_TYPE_ONLY_EXPORTS: readonly NodeTypeOnlyExport[] = [
  { module: "node:module", name: "ModuleSource" },
];

/** Recorded declaration-only names that a module namespace actually exposes. */
export function typeOnlyExportsAtRuntime(
  modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): readonly string[] {
  return NODE_TYPE_ONLY_EXPORTS.filter(
    (entry) => entry.name in (modules[entry.module] ?? {}),
  ).map((entry) => `${entry.module}#${entry.name}`);
}
