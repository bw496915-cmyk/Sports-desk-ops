/**
 * @file lib/quickjs_code_mode.ts
 * @description QuickJS guest realm for the profile Code Mode tools.
 *
 * The broad sportsdesk runner (`lib/code_mode.ts`) executes cells with `new AsyncFunction` in the
 * host realm, so a cell can reach `Bun`, `process` and `require`. This module is the isolated path
 * used for the profile tools: cells run inside a QuickJS context (WASM) whose only capability is a
 * synchronous `tools` bridge. Host values cross the boundary as native handles, never as JSON text.
 */

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import {
  getProfile,
  getSummary,
  queryProfiles,
} from "./profile_query_tools.ts";

const DEFAULT_TIMEOUT_MS = 5_000;

let quickJsModule: Promise<QuickJSWASMModule> | undefined;

const loadQuickJS = (): Promise<QuickJSWASMModule> => {
  quickJsModule ??= getQuickJS();
  return quickJsModule;
};

interface GuestValue {
  readonly handle: QuickJSHandle;
  /** True when this call allocated the handle and the caller must dispose it. */
  readonly owned: boolean;
}

/** Marshal a host value into the guest realm as native QuickJS values (no JSON hop). */
function toGuest(ctx: QuickJSContext, value: unknown): GuestValue {
  if (value === null) return { handle: ctx.null, owned: false };
  if (value === undefined) return { handle: ctx.undefined, owned: false };
  switch (typeof value) {
    case "number":
      return { handle: ctx.newNumber(value), owned: true };
    case "string":
      return { handle: ctx.newString(value), owned: true };
    case "boolean":
      return { handle: value ? ctx.true : ctx.false, owned: false };
    case "object":
      break;
    default:
      throw new Error(`quickjs_code_mode: cannot marshal ${typeof value}`);
  }

  if (Array.isArray(value)) {
    const array = ctx.newArray();
    for (const [index, entry] of value.entries()) {
      const child = toGuest(ctx, entry);
      ctx.setProp(array, index, child.handle);
      if (child.owned) child.handle.dispose();
    }
    return { handle: array, owned: true };
  }

  const object = ctx.newObject();
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const child = toGuest(ctx, entry);
    ctx.setProp(object, key, child.handle);
    if (child.owned) child.handle.dispose();
  }
  return { handle: object, owned: true };
}

type HostTool = (args: unknown) => unknown;

function installTools(ctx: QuickJSContext): void {
  const tools: Readonly<Record<string, HostTool>> = {
    query_profiles: (args) => queryProfiles(args),
    get_profile: (args) => getProfile(args),
    get_profile_summary: (args) => getSummary(args),
  };

  const toolsObject = ctx.newObject();
  for (const [name, hostTool] of Object.entries(tools)) {
    const fn = ctx.newFunction(name, (...argHandles) => {
      const [first] = argHandles;
      const args = first === undefined ? undefined : ctx.dump(first);
      const output = hostTool(args);
      return toGuest(ctx, output).handle;
    });
    ctx.setProp(toolsObject, name, fn);
    fn.dispose();
  }
  ctx.setProp(ctx.global, "tools", toolsObject);
  toolsObject.dispose();
}

/** QuickJS error objects dump as `{}`; read name/message handles before disposing. */
function describeGuestError(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
): string {
  const read = (prop: string): string | null => {
    const propHandle = ctx.getProp(handle, prop);
    if (!propHandle) return null;
    const value = ctx.dump(propHandle);
    propHandle.dispose();
    return typeof value === "string" ? value : null;
  };
  const name = read("name");
  const message = read("message");
  if (name === null && message === null) return String(ctx.dump(handle));
  return `${name ?? "Error"}: ${message ?? ""}`.trim();
}

export interface GuestCellOptions {
  readonly timeoutMs?: number;
}

/**
 * Execute a cell in a fresh QuickJS realm and return its value as a host value.
 * The cell is the body of a function: `return tools.query_profiles({...})`.
 */
export async function runGuestCell(
  source: string,
  options: GuestCellOptions = {},
): Promise<unknown> {
  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(
      Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ),
  );
  const ctx = runtime.newContext();
  try {
    installTools(ctx);
    const result = ctx.evalCode(`(function(){\n${source}\n})()`, "cell.js");
    if (result.error) {
      const message = describeGuestError(ctx, result.error);
      result.error.dispose();
      throw new Error(`quickjs_code_mode: guest cell failed: ${message}`);
    }
    const value = ctx.dump(result.value);
    result.value.dispose();
    return value;
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}
