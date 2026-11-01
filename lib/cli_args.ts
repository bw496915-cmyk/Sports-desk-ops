/**
 * @file lib/cli_args.ts
 * @description One flag parser for the capture and artifact CLIs.
 *
 * Ambiguity is the reason this exists: `--dry-run file.md` cannot be parsed without knowing which
 * flags take a value, so the caller declares them. Everything else is a switch, which keeps a
 * boolean flag from swallowing the next positional.
 */

export interface ParsedArgs {
  /** Flag values, collected in order; the last one wins for single-valued flags. */
  readonly values: ReadonlyMap<string, readonly string[]>;
  /** Flags with no value (`--dry-run`, `-h`). */
  readonly switches: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

export interface ParseOptions {
  /** Flags that consume the following token when it is not another flag. */
  readonly valueFlags?: readonly string[];
}

export function parseCliArgs(
  argv: readonly string[],
  options: ParseOptions = {},
): ParsedArgs {
  const valued = new Set(options.valueFlags ?? []);
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      const name = arg.slice(0, arg.indexOf("="));
      const value = arg.slice(arg.indexOf("=") + 1);
      values.set(name, [...(values.get(name) ?? []), value]);
      continue;
    }
    if (arg.startsWith("-")) {
      const next = argv[i + 1];
      if (valued.has(arg) && next !== undefined && !next.startsWith("-")) {
        values.set(arg, [...(values.get(arg) ?? []), next]);
        i += 1;
      } else {
        switches.add(arg);
      }
      continue;
    }
    positionals.push(arg);
  }

  return { values, switches, positionals };
}

export function hasFlag(
  args: ParsedArgs,
  ...names: readonly string[]
): boolean {
  return names.some((name) => args.switches.has(name) || args.values.has(name));
}

export function flagValue(
  args: ParsedArgs,
  name: string,
  fallback: string,
): string {
  const collected = args.values.get(name);
  return collected === undefined || collected.length === 0
    ? fallback
    : collected[collected.length - 1]!;
}

export function wantsHelp(args: ParsedArgs): boolean {
  return hasFlag(args, "--help", "-h");
}

/** Print usage; the caller's `main` returns immediately after. */
export function printHelp(text: string): void {
  process.stdout.write(`${text.trim()}\n`);
}
