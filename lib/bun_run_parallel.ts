/**
 * Bun 1.4 `bun run --parallel` / `--sequential` — concurrent package.json scripts.
 *
 * Replaces tools like npm-run-all and concurrently. Glob-match script names, fan
 * out across every workspace with `--filter`, keep going past failures with
 * `--no-exit-on-error`. Each line of output is prefixed with the script name
 * (or `package:script` under `--filter`); prebuild/postbuild hooks are grouped
 * with their main script so dependency order is preserved. `--sequential` runs
 * scripts one at a time with the same prefixed output and filtering.
 *
 * Closes: #26551
 *
 * @see https://bun.com/docs/pm/filter#parallel-and-sequential-mode
 * @see https://bun.com/blog/bun-v1.4#bun-run-parallel-since-1-3-9-improved-1-4-0
 * @see https://bun.com/blog/bun-v1.3.9#bun-run-parallel-and-bun-run-sequential
 */

export const BUN_RUN_PARALLEL_V14_BLOG_URL =
  "https://bun.sh/blog/bun-v1.4#bun-run-parallel-since-1-3-9-improved-1-4-0" as const;

export const BUN_RUN_PARALLEL_V139_BLOG_URL =
  "https://bun.sh/blog/bun-v1.3.9#bun-run-parallel-and-bun-run-sequential" as const;

/** v1.3.9 blog ship note — colored, padded labels. */
export const BUN_RUN_PARALLEL_V139_BLOG_SHIP_NOTE =
  "Run multiple package.json scripts concurrently or sequentially with Foreman-style prefixed output. Includes full --filter and --workspaces integration for running scripts in parallel or sequential across workspace packages." as const;

/** v1.3.9 capabilities — colored padded labels. */
export const BUN_RUN_PARALLEL_V139_BLOG_CAPABILITIES_SHIP_NOTE =
  "Each line of output is prefixed with a colored, padded label so you can tell which script produced it." as const;

export const BUN_RUN_PARALLEL_V14_BLOG_SHIP_NOTE =
  "bun run --parallel runs multiple package.json scripts concurrently with name-prefixed output. Glob-match script names, fan out across every workspace with --filter, and keep going past failures with --no-exit-on-error. This replaces tools like npm-run-all and concurrently. #26551" as const;

export const BUN_RUN_PARALLEL_V14_BLOG_CAPABILITIES_SHIP_NOTE =
  "Each line of output is prefixed with the script name (or package:script under --filter), and prebuild/postbuild hooks are grouped with their main script so dependency order is preserved. --sequential runs scripts one at a time with the same prefixed output and filtering." as const;

export const BUN_RUN_PARALLEL_PR_ID = 26551 as const;

export const BUN_RUN_PARALLEL_EXAMPLE_BUILD_TEST =
  "bun run --parallel build test" as const;
export const BUN_RUN_PARALLEL_EXAMPLE_GLOB =
  'bun run --parallel "build:*"' as const;
export const BUN_RUN_PARALLEL_EXAMPLE_FILTER =
  "bun run --parallel --filter '*' build" as const;
export const BUN_RUN_PARALLEL_EXAMPLE_NO_EXIT =
  "bun run --parallel --no-exit-on-error --filter '*' test" as const;
export const BUN_RUN_SEQUENTIAL_EXAMPLE =
  "bun run --sequential build test" as const;

export const BUN_RUN_PARALLEL_FLAGS = [
  "--parallel",
  "--sequential",
  "--filter",
  "--workspaces",
  "--no-exit-on-error",
  "--if-present",
  "--elide-lines",
] as const;

export const BUN_RUN_V14_BLOG_PARALLEL_URL = BUN_RUN_PARALLEL_V14_BLOG_URL;
export const BUN_RUN_PARALLEL_URL = BUN_RUN_PARALLEL_V14_BLOG_URL;
export const BUN_RUN_PARALLEL_BLOG_URL = BUN_RUN_PARALLEL_V14_BLOG_URL;
export const BUN_PARALLEL_RUN_V14_BLOG_URL = BUN_RUN_PARALLEL_V14_BLOG_URL;
export const BUN_RUN_V14_BLOG_URL = BUN_RUN_PARALLEL_V14_BLOG_URL;
export const BUN_RUN_SEQUENTIAL_V14_BLOG_URL = BUN_RUN_PARALLEL_V14_BLOG_URL;

export const BUN_RUN_PARALLEL_V14_SHIP_NOTE =
  BUN_RUN_PARALLEL_V14_BLOG_SHIP_NOTE;
export const BUN_RUN_PARALLEL_SHIP_NOTE = BUN_RUN_PARALLEL_V14_BLOG_SHIP_NOTE;
export const BUN_RUN_V14_BLOG_SHIP_NOTE = BUN_RUN_PARALLEL_V14_BLOG_SHIP_NOTE;
export const BUN_RUN_PARALLEL_CAPABILITIES_SHIP_NOTE =
  BUN_RUN_PARALLEL_V14_BLOG_CAPABILITIES_SHIP_NOTE;

export const BUN_RUN_PARALLEL_V139_SHIP_NOTE =
  BUN_RUN_PARALLEL_V139_BLOG_SHIP_NOTE;
export const BUN_RUN_PARALLEL_V139_BLOG_CAPABILITIES_SHIP_NOTE_ALIAS =
  BUN_RUN_PARALLEL_V139_BLOG_CAPABILITIES_SHIP_NOTE;

/** Grouped prebuild/postbuild hooks preserve dependency order. */
export const BUN_RUN_PARALLEL_PREBUILD_POSTBUILD_SHIP_NOTE =
  "prebuild/postbuild hooks are grouped with their main script so dependency order is preserved." as const;

/** Failure handling. */
export const BUN_RUN_PARALLEL_NO_EXIT_ON_ERROR_SHIP_NOTE =
  "By default, a failure in any script kills all remaining scripts — use --no-exit-on-error to let them all finish." as const;

/** Colored padded labels (v1.3.9). */
export const BUN_RUN_PARALLEL_COLORED_LABELS_SHIP_NOTE =
  "Each line of output is prefixed with a colored, padded label so you can tell which script produced it." as const;

/** Prefix formats. */
export const BUN_RUN_PARALLEL_PREFIX_SCRIPT = "build | compiling..." as const;
export const BUN_RUN_PARALLEL_PREFIX_PACKAGE =
  "pkg-a:build | compiling..." as const;

/** True when argv indicates a parallel/sequential run. */
export function isBunParallelRunInvocation(
  argv: readonly string[] = process.argv,
): boolean {
  return argv.includes("--parallel") || argv.includes("--sequential");
}

/** Format a prefixed output label. */
export function formatParallelLabel(script: string, pkg?: string): string {
  const base = pkg !== undefined && pkg !== "" ? `${pkg}:${script}` : script;
  return `${base} |`;
}
