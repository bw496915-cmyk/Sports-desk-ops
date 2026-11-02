/**
 * Config files as JSON5 or YAML, parsed with Bun.JSON5 / Bun.YAML and validated with a zod schema.
 *
 * Bun's parse errors carry no line or column ("YAML Parse error: Unexpected token", Bun 1.4.4), so
 * every message here leads with the file path: it is the only location the operator gets.
 */

import { basename, extname } from "node:path";
import type { z } from "zod";
import { UsageError } from "./usage_error.ts";

export type ConfigFormat = "json5" | "yaml";

/** JSON and JSONC are subsets of JSON5, so all three go through Bun.JSON5. */
const FORMAT_BY_EXTENSION: Readonly<Record<string, ConfigFormat>> = {
  ".json": "json5",
  ".jsonc": "json5",
  ".json5": "json5",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/** Throws {@link UsageError} for a path whose extension is not a supported config format. */
export function configFormat(path: string): ConfigFormat {
  const name = basename(path);
  // extname(".yaml") is "": a bare dotfile name is its own extension.
  const ext = (
    extname(name) || (name.startsWith(".") ? name : "")
  ).toLowerCase();
  const format = FORMAT_BY_EXTENSION[ext];
  if (format === undefined) {
    throw new UsageError(
      `${path}: unsupported config extension ${ext === "" ? "(none)" : `"${ext}"`}; use ${Object.keys(FORMAT_BY_EXTENSION).join(", ")}`,
    );
  }
  return format;
}

/**
 * The parsed value, unvalidated. A YAML stream with several `---` documents comes back as an array,
 * which is indistinguishable from a single document whose top level is a list: the schema decides.
 */
export function parseConfig(
  raw: string,
  format: ConfigFormat,
  source = "config",
): unknown {
  try {
    return format === "yaml" ? Bun.YAML.parse(raw) : Bun.JSON5.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new UsageError(`${source}: ${error.message}`, { cause: error });
  }
}

/** Reads, parses and validates one config file; every failure is a {@link UsageError} naming it. */
export async function readConfig<S extends z.ZodType>(
  path: string,
  schema: S,
): Promise<z.output<S>> {
  const format = configFormat(path);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new UsageError(`${path}: no such file`);
  const parsed = schema.safeParse(parseConfig(await file.text(), format, path));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(
        (issue) =>
          `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
      )
      .join("; ");
    throw new UsageError(`${path}: ${issues}`, { cause: parsed.error });
  }
  return parsed.data;
}
