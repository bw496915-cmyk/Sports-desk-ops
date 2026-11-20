/**
 * @file lib/console_depth.ts
 * @description One implementation of the console-depth resolution chain, shared by
 * the terminal `depth` command, `cli/console_depth.ts`, and the DSH plugin tool.
 *
 * Chain: an explicit resolved option, then `[console].depth` from bunfig, then the
 * profile-emitted `PTY_CONSOLE_DEPTH`, then Bun's default. On the 1.4.4 pin a numeric
 * bunfig depth wins at runtime over both `BUN_OPTIONS` and a literal argv flag, so the
 * chain reports bunfig as the effective winner whenever it is present.
 */

import { resolve } from "node:path";

import { readBunfigConsoleDepth } from "./token_automation.ts";

/** `999999` is the registry's stored Infinity sentinel, never a runnable depth. */
export const MAX_CONSOLE_DEPTH = 999_999;

export type ConsoleDepthWinner =
  | "bunfig [console].depth"
  | "resolved option"
  | "PTY_CONSOLE_DEPTH"
  | "Bun default";

export interface ConsoleDepthReading {
  /** The raw profile value, preserved so an invalid one can be reported verbatim. */
  readonly raw: string | null;
  readonly value: number | null;
}

export interface ConsoleDepthChain {
  readonly cwd: string;
  readonly bunfigPath: string;
  readonly profileEnv: ConsoleDepthReading;
  readonly explicit: number | null;
  readonly bunfig: number | null;
  readonly effective: number;
  readonly winner: ConsoleDepthWinner;
}

export function asConsoleDepth(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_CONSOLE_DEPTH
    ? value
    : null;
}

export interface ResolveConsoleDepthChainOptions {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly consoleDepth?: number | undefined;
}

export async function resolveConsoleDepthChain(
  options: ResolveConsoleDepthChainOptions = {},
): Promise<ConsoleDepthChain> {
  const cwd = options.cwd ?? process.cwd();
  const bunfigPath = resolve(cwd, "bunfig.toml");
  const bunfig = await readBunfigConsoleDepth(bunfigPath);
  const raw = options.env?.PTY_CONSOLE_DEPTH ?? process.env.PTY_CONSOLE_DEPTH;
  const profileEnv: ConsoleDepthReading = {
    raw: raw ?? null,
    value:
      raw === undefined || raw.trim() === ""
        ? null
        : asConsoleDepth(Number(raw)),
  };
  const explicit = asConsoleDepth(options.consoleDepth);
  const effective = bunfig ?? explicit ?? profileEnv.value ?? 2;
  const winner: ConsoleDepthWinner =
    bunfig !== null
      ? "bunfig [console].depth"
      : explicit !== null
        ? "resolved option"
        : profileEnv.value !== null
          ? "PTY_CONSOLE_DEPTH"
          : "Bun default";
  return {
    cwd,
    bunfigPath,
    profileEnv,
    explicit,
    bunfig,
    effective,
    winner,
  };
}

const DEPTH_RULE = "═".repeat(72);

function readingText(reading: ConsoleDepthReading): string {
  if (reading.value !== null) return String(reading.value);
  return reading.raw === null
    ? "unset"
    : `invalid (${JSON.stringify(reading.raw)})`;
}

/** Human-readable report for the terminal `depth` command. */
export function renderConsoleDepthReport(chain: ConsoleDepthChain): string {
  return [
    "\x1b[1;36mCONSOLE DEPTH\x1b[0m",
    DEPTH_RULE,
    `  profile env PTY_CONSOLE_DEPTH : ${readingText(chain.profileEnv)}`,
    `  resolved option              : ${chain.explicit === null ? "unset" : String(chain.explicit)}`,
    `  bunfig file                  : ${chain.bunfigPath}`,
    `  bunfig [console].depth       : ${chain.bunfig === null ? "unset" : String(chain.bunfig)}`,
    `  effective at runtime         : ${chain.effective} (${chain.winner})`,
    DEPTH_RULE,
    "  \x1b[90mBun 1.4.4: a numeric bunfig depth beats BUN_OPTIONS and argv.\x1b[0m",
    "  \x1b[90mconsole.dir(v,{depth}) still overrides per call; node:console ignores bunfig.\x1b[0m",
  ].join("\n");
}
