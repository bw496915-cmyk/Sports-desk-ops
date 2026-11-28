#!/usr/bin/env bun
/**
 * @file scripts/build_token_watch.ts
 * @description Build the compiled token-watch binary with the string-codegen lockdown baked in.
 *
 * Measured 2026-11-18 on the pin (Bun 1.4.4+38afee6c8): a compiled binary ignores a runtime
 * `--disallow-code-generation-from-strings=strict` and forwards it to the app as an argument, so
 * `new Function` still runs. Only the build-time
 * `--compile-exec-argv=--disallow-code-generation-from-strings=strict` hardens the executable: the
 * binary then throws `EvalError` for string code generation. Every token-watch build goes through
 * this script so the lockdown cannot be forgotten; `tokenWatchBuildArgs` is the single, ordered
 * argv contract and no shell string is ever built.
 *
 *   bun run scripts/build_token_watch.ts --entry <path> --out <path>
 *   bun run scripts/build_token_watch.ts --entry <path> --out <path> -- <extra bun build args>
 */

/** The build-time flag that hardens the standalone executable against string codegen. */
export const TOKEN_WATCH_LOCKDOWN_ARGV: readonly string[] = [
  "--compile-exec-argv=--disallow-code-generation-from-strings=strict",
];

export interface TokenWatchBuildOptions {
  readonly entrypoint: string;
  readonly outfile: string;
  readonly extraArgs?: readonly string[];
}

/** The exact `bun build` argv for a hardened token-watch binary (arrays only, no shell string). */
export function tokenWatchBuildArgs(options: TokenWatchBuildOptions): string[] {
  return [
    "build",
    options.entrypoint,
    "--compile",
    ...TOKEN_WATCH_LOCKDOWN_ARGV,
    ...(options.extraArgs ?? []),
    "--outfile",
    options.outfile,
  ];
}

/** Injectable build step result; the default runner is `Bun.spawnSync`. */
export interface TokenWatchRunResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export type TokenWatchBuildResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly exitCode: number; readonly stderr: string };

type TokenWatchRunner = (argv: readonly string[]) => TokenWatchRunResult;

const defaultRun: TokenWatchRunner = (argv) => {
  const proc = Bun.spawnSync([process.execPath, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stderr: proc.stderr?.toString() ?? "",
  };
};

/**
 * Build one hardened token-watch binary. `run` is injectable so the failure path is testable
 * without a real build.
 */
export function buildTokenWatch(
  options: TokenWatchBuildOptions,
  run: TokenWatchRunner = defaultRun,
): TokenWatchBuildResult {
  const result = run(tokenWatchBuildArgs(options));
  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
}

const USAGE =
  "usage: bun run scripts/build_token_watch.ts --entry <path> --out <path> [-- <extra bun build args>]";

/** `--entry <path>` / `--out <path>` (or the `=` form); args after `--` pass to `bun build`. */
function parseCli(argv: readonly string[]): TokenWatchBuildOptions | string {
  let entrypoint: string | undefined;
  let outfile: string | undefined;
  const extraArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      extraArgs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--entry" || arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return `${arg} expects a path`;
      }
      if (arg === "--entry") entrypoint = value;
      else outfile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--entry=")) {
      entrypoint = arg.slice("--entry=".length);
      continue;
    }
    if (arg.startsWith("--out=")) {
      outfile = arg.slice("--out=".length);
      continue;
    }
    return `unexpected argument: ${arg}`;
  }
  if (entrypoint === undefined) return "missing required --entry <path>";
  if (outfile === undefined) return "missing required --out <path>";
  return { entrypoint, outfile, extraArgs };
}

if (import.meta.main) {
  const parsed = parseCli(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(`token-watch build: ${parsed}`);
    console.error(USAGE);
    process.exit(2);
  }
  const result = buildTokenWatch(parsed);
  if (!result.ok) {
    console.error(
      `token-watch build failed (exit ${result.exitCode}): ${result.stderr.trim() || "no stderr"}`,
    );
    console.error(USAGE);
    process.exit(result.exitCode);
  }
  console.log(parsed.outfile);
}
