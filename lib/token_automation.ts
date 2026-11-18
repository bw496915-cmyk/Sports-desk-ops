/**
 * @file lib/token_automation.ts
 * @description Dual-column SQLite token store (canonical colour name + packed 24-bit number) that
 * generates the runtime `Bun.markdown.AnsiTheme`, `Bun.markdown.render()` callbacks, a dual-value
 * `.env` profile, and a static TypeScript LUT in one pass.
 *
 * Every write is validated through `Bun.color(name, "number")`; the STRICT table keeps the name,
 * the 24-bit integer and the hex string together so `.env`, the TypeScript LUT, `AnsiTheme` and
 * terminal sessions cannot drift apart.
 */
import { Database } from "bun:sqlite";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import {
  BUILTIN_PROFILES,
  deriveColorToken,
  detectColorDepth,
  depthToAnsiFormat,
  type ColorDepth,
  type DerivedColorToken,
  type ProfileInspectSettings,
  type ThemeRole,
} from "./bun_profiled_terminal.ts";

export interface StoredDualColorRow {
  readonly profile: string;
  readonly role: ThemeRole;
  readonly color_name: string;
  readonly color_number: number;
  readonly hex: string;
}

export interface GeneratedProfileBundle {
  readonly profile: string;
  readonly depth: ColorDepth;
  readonly inspect: ProfileInspectSettings;
  readonly tokens: Record<ThemeRole, DerivedColorToken | null>;
  /** Shipped `Bun.markdown.AnsiTheme` (colors, columns, hyperlinks, kittyGraphics, light). */
  readonly ansiTheme: Bun.markdown.AnsiTheme;
  /** Element callbacks for `Bun.markdown.render(md, callbacks, gfmOpts)`. */
  readonly renderCallbacks: Parameters<typeof Bun.markdown.render>[1];
  /** Generated `.env` block storing both `PTY_<ROLE>` (name) and `PTY_<ROLE>_NUMBER` (int). */
  readonly dotEnvText: string;
  /** Generated static TypeScript LUT module with const colour names, numbers and SGR escapes. */
  readonly generatedTsModule: string;
}

const GFM_PARSER_OPTS = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
} as const;

const THEME_ROLES: readonly ThemeRole[] = [
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

type SettingsRow = {
  console_depth: number;
  sorted: number;
  compact: number;
  max_array_length: number;
};

export class AutomatedDualTokenStore {
  private readonly db: Database;

  constructor(dbPath = ":memory:", seedBuiltins = true) {
    // House rule: SQLite opens only through lib/sportsdesk_sqlite.ts (strict + safeIntegers).
    this.db = openSportsdeskSqlite(dbPath);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA busy_timeout = 2000;");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS dual_theme_tokens (
        profile TEXT NOT NULL,
        role TEXT NOT NULL,
        color_name TEXT NOT NULL CHECK (length(trim(color_name)) > 0),
        color_number INTEGER NOT NULL CHECK (color_number BETWEEN 0 AND 16777215),
        hex TEXT NOT NULL CHECK (hex LIKE '#______'),
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

    if (seedBuiltins) {
      for (const [name, preset] of Object.entries(BUILTIN_PROFILES)) {
        this.upsertProfile(name, preset.colors, preset.inspect, false);
      }
    }
  }

  /**
   * Validate `colorName` through `Bun.color()` and store the name plus its packed 24-bit number.
   * @throws ERR_COLOR_INVALID when Bun cannot parse the name.
   */
  upsertToken(
    profile: string,
    role: ThemeRole,
    colorName: string,
    overwrite = true,
  ): StoredDualColorRow {
    const normalized = colorName.trim().toLowerCase();
    const parsed = Bun.color(normalized, "number");
    if (parsed === null) {
      throw new Error(
        `ERR_COLOR_INVALID: ${JSON.stringify(colorName)} failed Bun.color(..., "number") validation.`,
      );
    }
    // Unsigned 24-bit: no signed 32-bit shift overflow.
    const colorNumber = (parsed >>> 0) & 0xffffff;
    const hex =
      Bun.color(colorNumber, "hex") ??
      `#${colorNumber.toString(16).padStart(6, "0")}`;

    const sql = overwrite
      ? `INSERT INTO dual_theme_tokens (profile, role, color_name, color_number, hex, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
         ON CONFLICT(profile, role) DO UPDATE SET
           color_name = excluded.color_name,
           color_number = excluded.color_number,
           hex = excluded.hex,
           updated_at = unixepoch()`
      : `INSERT OR IGNORE INTO dual_theme_tokens (profile, role, color_name, color_number, hex, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())`;

    this.db.query(sql).run(profile, role, normalized, colorNumber, hex);
    return {
      profile,
      role,
      color_name: normalized,
      color_number: colorNumber,
      hex,
    };
  }

  upsertProfile(
    profile: string,
    colors: Partial<Record<ThemeRole, string>>,
    inspect?: Partial<ProfileInspectSettings>,
    overwrite = true,
  ): void {
    const settingsSql = overwrite
      ? `INSERT INTO profile_settings (profile, console_depth, sorted, compact, max_array_length, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
         ON CONFLICT(profile) DO UPDATE SET
           console_depth = excluded.console_depth,
           sorted = excluded.sorted,
           compact = excluded.compact,
           max_array_length = excluded.max_array_length,
           updated_at = unixepoch()`
      : `INSERT OR IGNORE INTO profile_settings (profile, console_depth, sorted, compact, max_array_length, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())`;

    const transaction = this.db.transaction(() => {
      for (const [role, name] of Object.entries(colors)) {
        if (name) this.upsertToken(profile, role as ThemeRole, name, overwrite);
      }
      if (inspect) {
        const depth = inspect.consoleDepth ?? 2;
        this.db
          .query(settingsSql)
          .run(
            profile,
            depth === Number.POSITIVE_INFINITY ? 999_999 : depth,
            inspect.sorted ? 1 : 0,
            inspect.compact ? 1 : 0,
            inspect.maxArrayLength ?? 100,
          );
      }
    });
    transaction();
  }

  getRows(profile: string): StoredDualColorRow[] {
    return this.db
      .query(
        `SELECT profile, role, color_name, color_number, hex
         FROM dual_theme_tokens WHERE profile = ?1 ORDER BY role`,
      )
      .all(profile)
      .map((row) => {
        // `safeIntegers` returns bigint; the row contract is a number.
        const stored = row as StoredDualColorRow & {
          color_number: number | bigint;
        };
        return { ...stored, color_number: Number(stored.color_number) };
      });
  }

  getInspect(profile: string): ProfileInspectSettings {
    const row = this.db
      .query(
        `SELECT console_depth, sorted, compact, max_array_length
         FROM profile_settings WHERE profile = ?1`,
      )
      .get(profile) as SettingsRow | null;

    if (row === null) {
      return {
        consoleDepth: 2,
        sorted: false,
        compact: false,
        maxArrayLength: 100,
      };
    }
    return {
      consoleDepth:
        Number(row.console_depth) >= 999_999
          ? Number.POSITIVE_INFINITY
          : Number(row.console_depth),
      sorted: Number(row.sorted) === 1,
      compact: Number(row.compact) === 1,
      maxArrayLength: Number(row.max_array_length),
    };
  }

  listProfiles(): string[] {
    return this.db
      .query("SELECT DISTINCT profile FROM dual_theme_tokens ORDER BY profile")
      .all()
      .map((row) => (row as { profile: string }).profile);
  }

  /** Generate the runtime theme, `AnsiTheme`, dual-value `.env` and TypeScript LUT for one profile. */
  generateBundle(
    profile: string,
    options?: {
      env?: Record<string, string | undefined>;
      isTTY?: boolean;
      columns?: number;
    },
  ): GeneratedProfileBundle {
    const rows = this.getRows(profile);
    if (rows.length === 0) {
      throw new Error(
        `ERR_PROFILE_NOT_FOUND: Profile "${profile}" has no stored tokens.`,
      );
    }

    const mergedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries({
      ...process.env,
      ...options?.env,
    })) {
      if (value !== undefined) mergedEnv[key] = value;
    }

    const isTTY = options?.isTTY ?? Boolean(process.stdout.isTTY);
    const depth = detectColorDepth(mergedEnv, isTTY);
    const ansiFormat = depthToAnsiFormat(depth);
    const inspect = this.getInspect(profile);

    const rowByRole = new Map(rows.map((row) => [row.role, row]));
    const tokens = {} as Record<ThemeRole, DerivedColorToken | null>;
    for (const role of THEME_ROLES) {
      const stored = rowByRole.get(role);
      tokens[role] = stored
        ? deriveColorToken(role, stored.color_name, ansiFormat)
        : null;
    }

    // 1. Shipped AnsiTheme, derived from the stored tokens and the detected depth.
    const colorsEnabled = depth !== "none";
    const ansiTheme: Bun.markdown.AnsiTheme = {
      colors: colorsEnabled,
      columns: options?.columns ?? process.stdout.columns ?? 80,
      hyperlinks: colorsEnabled && isTTY,
      kittyGraphics:
        colorsEnabled &&
        isTTY &&
        Boolean(
          mergedEnv.KITTY_WINDOW_ID ??
          /kitty|wezterm|ghostty/i.test(
            `${mergedEnv.TERM ?? ""} ${mergedEnv.TERM_PROGRAM ?? ""}`,
          ),
        ),
      ...(tokens.bg ? { light: tokens.bg.luminance > 0.5 } : {}),
    };

    // 2. Element callbacks for Bun.markdown.render(), using the stored SGR escapes.
    const accent =
      tokens.accent ?? deriveColorToken("accent", "dodgerblue", ansiFormat);
    const info = tokens.info ?? accent;
    const warn = tokens.warn ?? accent;
    const code = tokens.code ?? accent;
    const muted = tokens.muted ?? accent;

    const renderCallbacks: Parameters<typeof Bun.markdown.render>[1] =
      colorsEnabled
        ? {
            heading: (content, { level }) =>
              `\n\x1b[1m${level === 1 ? accent.ansiFg : info.ansiFg}${"#".repeat(level)} ${content}\x1b[0m\n`,
            strong: (content) => `\x1b[1m${warn.ansiFg}${content}\x1b[0m`,
            codespan: (content) => `${code.ansiFg}\`${content}\`\x1b[39m`,
            link: (content, { href }) =>
              ansiTheme.hyperlinks && href
                ? `\x1b]8;;${href}\x07${accent.ansiFg}\x1b[4m${content}\x1b[24m\x1b[39m\x1b]8;;\x07`
                : `${accent.ansiFg}${content}\x1b[39m ${muted.ansiFg}(${href})\x1b[39m`,
          }
        : {};

    // 3. Dual-value .env: name + 24-bit integer, with expansion for repeated colours.
    const depthText =
      inspect.consoleDepth === Number.POSITIVE_INFINITY
        ? "Infinity"
        : String(inspect.consoleDepth);
    const envLines: string[] = [
      `# Auto-generated dual-token profile: ${profile}`,
      `PTY_PROFILE="${profile}"`,
      `PTY_CONSOLE_DEPTH="${depthText}"`,
      ...(Number.isFinite(inspect.consoleDepth)
        ? [`BUN_OPTIONS="--console-depth=${inspect.consoleDepth}"`]
        : []),
    ];

    const seenColorVar = new Map<string, string>();
    for (const row of rows) {
      const baseKey = `PTY_${row.role.toUpperCase()}`;
      const existing = seenColorVar.get(row.color_name);
      if (existing !== undefined) {
        envLines.push(`${baseKey}=$${existing}`);
        envLines.push(`${baseKey}_NUMBER=$${existing}_NUMBER`);
      } else {
        envLines.push(`${baseKey}="${row.color_name}"`);
        envLines.push(`${baseKey}_NUMBER=${row.color_number}`);
        seenColorVar.set(row.color_name, baseKey);
      }
    }

    // 4. Static TypeScript LUT: SGR escapes are precomputed at generation time.
    const tokenEntries = rows
      .map((row) => {
        const sgr16m = JSON.stringify(
          Bun.color(row.color_number, "ansi-16m") ?? "",
        );
        const sgr256 = JSON.stringify(
          Bun.color(row.color_number, "ansi-256") ?? "",
        );
        return `    ${row.role}: { name: ${JSON.stringify(row.color_name)}, number: 0x${row.color_number
          .toString(16)
          .padStart(
            6,
            "0",
          )}, hex: ${JSON.stringify(row.hex)}, ansi16m: ${sgr16m}, ansi256: ${sgr256} }`;
      })
      .join(",\n");

    const constName = `GENERATED_PROFILE_${profile.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
    const generatedTsModule = [
      `// AUTO-GENERATED BY token_automation.ts — DO NOT EDIT MANUALLY`,
      `export const ${constName} = {`,
      `  profile: ${JSON.stringify(profile)},`,
      `  consoleDepth: ${inspect.consoleDepth === Number.POSITIVE_INFINITY ? "Infinity" : inspect.consoleDepth},`,
      `  ansiTheme: ${JSON.stringify(ansiTheme)},`,
      `  tokens: {`,
      tokenEntries,
      `  },`,
      `} as const;\n`,
    ].join("\n");

    return {
      profile,
      depth,
      inspect,
      tokens,
      ansiTheme,
      renderCallbacks,
      dotEnvText: `${envLines.join("\n")}\n`,
      generatedTsModule,
    };
  }

  /** Write `.env.<profile>` and `<profile>.theme.gen.ts` into `outDir`. */
  async emitArtifacts(
    profile: string,
    outDir: string,
    options?: { env?: Record<string, string | undefined>; isTTY?: boolean },
  ): Promise<{
    envFile: string;
    tsFile: string;
    bundle: GeneratedProfileBundle;
  }> {
    const bundle = this.generateBundle(profile, options);
    const envFile = `${outDir}/.env.${profile}`;
    const tsFile = `${outDir}/${profile}.theme.gen.ts`;

    // Bun.write creates missing parent directories (0755), so no node:fs mkdir is needed.
    await Promise.all([
      Bun.write(envFile, bundle.dotEnvText),
      Bun.write(tsFile, bundle.generatedTsModule),
    ]);

    return { envFile, tsFile, bundle };
  }

  renderMarkdown(
    markdown: string,
    bundle: GeneratedProfileBundle,
    mode: "native" | "themed" = "themed",
  ): string {
    if (mode === "native" || bundle.depth === "none") {
      return Bun.markdown.ansi(markdown, bundle.ansiTheme);
    }
    return Bun.markdown.render(
      markdown,
      bundle.renderCallbacks,
      GFM_PARSER_OPTS,
    );
  }

  close(): void {
    this.db.close();
  }
}

/**
 * `codegen` subcommand body: emit both artifacts for one profile and print a short summary.
 *
 * Kept as a function because this repo has no `profile-cli.ts`; wire it into whatever CLI owns
 * profile management. Accepts flags (`--profile X --out-dir Y`) or the positional form.
 * @param dbPath - SQLite file the dual-token store lives in.
 * @param args - subcommand arguments after `codegen`.
 * @returns process exit code: 0 written, 2 unknown profile, 1 failure.
 */
export async function runCodegenSubcommand(
  dbPath: string,
  args: string[],
): Promise<number> {
  let profileFlag: string | undefined;
  let outDirFlag: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--profile") profileFlag = args[++index];
    else if (arg.startsWith("--profile="))
      profileFlag = arg.slice("--profile=".length);
    else if (arg === "--out-dir") outDirFlag = args[++index];
    else if (arg.startsWith("--out-dir="))
      outDirFlag = arg.slice("--out-dir=".length);
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  const profile =
    profileFlag ?? positional[0] ?? Bun.env.PTY_PROFILE ?? "default";
  const outDir = outDirFlag ?? positional[1] ?? "./generated";

  const store = new AutomatedDualTokenStore(dbPath, true);
  try {
    if (!store.listProfiles().includes(profile)) {
      console.error(`ERR_PROFILE_NOT_FOUND: "${profile}"`);
      return 2;
    }
    const { envFile, tsFile, bundle } = await store.emitArtifacts(
      profile,
      outDir,
      { isTTY: true },
    );
    process.stdout.write(
      store.renderMarkdown(
        `# Generated \`${profile}\`\n- Env: \`${envFile}\`\n- Theme LUT: \`${tsFile}\`\n- Console Depth: **${bundle.inspect.consoleDepth}**`,
        bundle,
      ),
    );
    return 0;
  } finally {
    store.close();
  }
}
