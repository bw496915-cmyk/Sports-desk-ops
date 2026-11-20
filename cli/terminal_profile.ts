#!/usr/bin/env bun
/**
 * @file cli/terminal_profile.ts
 * @description Read-only inspection of the persisted terminal profile store
 * (`scratch/theme-tokens.sqlite`) plus the console-depth resolution chain.
 *
 * The store is opened read-only: inspecting must never create or migrate it.
 * A missing database is reported as `exists: false`, never as zero profiles.
 *
 *   bun cli/terminal_profile.ts [--db PATH] [--profile ID] [--options] [--json]
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { resolveConsoleDepthChain } from "../lib/console_depth.ts";
import { openSportsdeskSqliteReadonly } from "../lib/sportsdesk_sqlite.ts";

const DEFAULT_DB = "scratch/theme-tokens.sqlite";
interface ProfileReport {
  readonly id: string;
  readonly consoleDepth: number | "Infinity";
  readonly sorted: boolean;
  readonly compact: boolean;
  readonly maxArrayLength: number;
  readonly tokenCount: number;
  readonly themeCount: number;
  readonly updatedAt: number | null;
}

function parseArgs(argv: readonly string[]): {
  readonly db: string;
  readonly profile: string | undefined;
  readonly json: boolean;
  readonly options: boolean;
} {
  let db = DEFAULT_DB;
  let profile: string | undefined;
  let json = false;
  let options = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--options") {
      options = true;
      continue;
    }
    if (arg === "--db" || arg.startsWith("--db=")) {
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : argv[++index];
      if (!value || value.startsWith("-")) throw new Error("--db needs a path");
      db = value;
      continue;
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : argv[++index];
      if (!value || value.startsWith("-")) {
        throw new Error("--profile needs an id");
      }
      profile = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }

  return { db, profile, json, options };
}

function readProfiles(
  dbPath: string,
  profileFilter: string | undefined,
): { readonly schema: boolean; readonly profiles: ProfileReport[] } {
  const sqlite = openSportsdeskSqliteReadonly(dbPath);
  try {
    const tables = new Set(
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String((row as { name: unknown }).name)),
    );
    const hasSettings = tables.has("profile_settings");
    const hasTokens = tables.has("dual_theme_tokens");
    const hasThemes = tables.has("profile_themes");
    if (!hasSettings && !hasTokens && !hasThemes) {
      return { schema: false, profiles: [] };
    }

    const union: string[] = [];
    if (hasSettings) {
      union.push("SELECT profile AS id FROM profile_settings");
    }
    if (hasTokens) {
      union.push("SELECT DISTINCT profile AS id FROM dual_theme_tokens");
    }
    if (hasThemes) {
      union.push("SELECT DISTINCT profile_id AS id FROM profile_themes");
    }
    const ids = (
      sqlite
        .query(`SELECT id FROM (${union.join(" UNION ")}) ORDER BY id`)
        .all() as Array<{ id: string }>
    )
      .map((row) => String(row.id))
      .filter((id) => profileFilter === undefined || id === profileFilter);

    const profiles = ids.map((id) => {
      const settings = hasSettings
        ? (sqlite
            .query(
              "SELECT console_depth, sorted, compact, max_array_length, updated_at FROM profile_settings WHERE profile = ?1",
            )
            .get(id) as {
            console_depth: number | bigint;
            sorted: number | bigint;
            compact: number | bigint;
            max_array_length: number | bigint;
            updated_at: number | bigint;
          } | null)
        : null;
      const depth = Number(settings?.console_depth ?? 2);
      const tokenCount = hasTokens
        ? Number(
            (
              sqlite
                .query(
                  "SELECT COUNT(*) AS n FROM dual_theme_tokens WHERE profile = ?1",
                )
                .get(id) as { n: number | bigint }
            ).n,
          )
        : 0;
      const themeCount = hasThemes
        ? Number(
            (
              sqlite
                .query(
                  "SELECT COUNT(*) AS n FROM profile_themes WHERE profile_id = ?1",
                )
                .get(id) as { n: number | bigint }
            ).n,
          )
        : 0;
      return {
        id,
        consoleDepth: depth >= 999_999 ? ("Infinity" as const) : depth,
        sorted: Number(settings?.sorted ?? 0) === 1,
        compact: Number(settings?.compact ?? 0) === 1,
        maxArrayLength: Number(settings?.max_array_length ?? 100),
        tokenCount,
        themeCount,
        updatedAt: settings ? Number(settings.updated_at) : null,
      } satisfies ProfileReport;
    });

    return { schema: true, profiles };
  } finally {
    sqlite.close();
  }
}

const args = parseArgs(Bun.argv.slice(2));
const dbPath = resolve(process.cwd(), args.db);
const exists = existsSync(dbPath);
const store = exists
  ? readProfiles(dbPath, args.profile)
  : { schema: false, profiles: [] };
const depthChain = await resolveConsoleDepthChain({
  cwd: process.cwd(),
  env: Bun.env,
});

const report = {
  db: { path: args.db, exists, schema: exists ? store.schema : null },
  profileFilter: args.profile ?? null,
  count: store.profiles.length,
  profiles: store.profiles,
  environment: {
    PTY_CONSOLE_DEPTH: depthChain.profileEnv.raw,
    bunfigPath: depthChain.bunfigPath,
    bunfigDepth: depthChain.bunfig,
    effectiveDepth: depthChain.effective,
    winner: depthChain.winner,
  },
  platform: process.platform,
};

if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [
    "TERMINAL PROFILE",
    "═".repeat(72),
    `  store        : ${report.db.path}${exists ? "" : " (MISSING)"}`,
    `  schema       : ${store.schema ? "present" : exists ? "missing tables" : "n/a"}`,
    `  profiles     : ${report.count}`,
    `  runtime depth: ${depthChain.effective} (${depthChain.winner})`,
    "═".repeat(72),
  ];
  for (const profile of report.profiles) {
    if (!args.options) {
      lines.push(
        `  ${profile.id.padEnd(16)} depth ${String(profile.consoleDepth).padEnd(8)} themes ${profile.themeCount} tokens ${profile.tokenCount}`,
      );
      continue;
    }
    lines.push(
      `  ${profile.id}`,
      `    console depth   : ${profile.consoleDepth}`,
      `    sorted          : ${profile.sorted ? "on" : "off"}`,
      `    compact         : ${profile.compact ? "on" : "off"}`,
      `    max array length: ${profile.maxArrayLength}`,
      `    tokens/themes   : ${profile.tokenCount}/${profile.themeCount}`,
      `    updated         : ${
        profile.updatedAt === null
          ? "not persisted"
          : new Date(profile.updatedAt * 1000).toISOString()
      }`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}
