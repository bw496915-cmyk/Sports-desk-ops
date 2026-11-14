import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  DODSPINE_LEAK_BASELINE,
  JSON_ARTIFACT_BASELINE,
  LOOP_INDEX_BASELINE,
  ROOT_MANIFEST_FIELD_BASELINE,
  LEAF_NAME_BASELINE,
} from "./bun_native_rules.baseline.ts";

export type GateCode =
  | "ERR_LOCKFILE_MISSING"
  | "ERR_LOCKFILE_VERSION"
  | "ERR_LINKER_NOT_ISOLATED"
  | "ERR_FOREIGN_LOCKFILE"
  | "ERR_NESTED_BUN_LOCK"
  | "ERR_NPMRC_FORBIDDEN"
  | "ERR_URL_EMBEDDED_CREDENTIAL"
  | "ERR_NPM_DOUBLE_BASE64_PAT"
  | "ERR_CF_TOKEN_BLEED_10000"
  | "ERR_GITATTRIBUTES_ORDER"
  | "ERR_BUN_GLOBAL_INSTALL"
  | "ERR_BUNFIG_MULTILINE_INLINE_TABLE"
  | "ERR_BUNFIG_INSTALL_FLOOR"
  | "ERR_BUNFIG_YARN_LOCKFILE"
  | "ERR_BUNFIG_LITERAL_CREDENTIAL"
  | "ERR_ROOT_MANIFEST"
  | "ERR_LEAF_MANIFEST"
  | "ERR_LINT_SCRIPT_RECURSION"
  | "ERR_DODSPINE_NAMING_LEAK"
  | "ERR_LOOP_INDEX_NOT_DESCRIPTIVE"
  | "ERR_BUN_SOURCE_URL_NOT_PINNED"
  | "ERR_OPS_LOCAL_JSON_FORBIDDEN";

export type FindingSeverity = "error" | "waived" | "notice";

export type GateFinding = {
  readonly code: GateCode;
  readonly rule: string;
  readonly severity: FindingSeverity;
  readonly file?: string;
  readonly line?: number;
  readonly detail: string;
};

export class GateRuleError extends Error {
  override readonly name = "GateRuleError";
  constructor(
    readonly code: GateCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export type RepoView = {
  readonly root: string;
  /** Repo-relative paths: tracked files plus untracked files that are not gitignored. */
  readonly files: readonly string[];
  /** `.env*` / `*.env` files on disk (gitignored included), never under node_modules. */
  readonly envFiles: readonly string[];
};

export type RuleContext = {
  /** Bun version used to decide whether `bun lint` is native (>= 1.5) or a package script. */
  readonly bunVersion: string;
};

export type GateRule = {
  readonly id: string;
  readonly run: (
    view: RepoView,
    context: RuleContext,
  ) => Promise<GateFinding[]>;
};

export const PINNED_BUN_SHA = "38afee6c84fcf48c0edb2466aa4b27d287a59c30";
/** Bun 1.4.4 writes text lockfiles with `lockfileVersion: 2` (measured); the spec's `1` predates it. */
export const EXPECTED_LOCKFILE_VERSION = 2;
export const EXPECTED_LOCK_CONFIG_VERSION = 1;
export const FOREIGN_LOCKFILE_NAMES: readonly string[] = [
  "bun.lockb",
  "yarn.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
];
export const ISOLATED_SECRET_FILES: Readonly<
  Record<string, readonly string[]>
> = {
  "registry.env": ["NPM_"],
  "r2.env": ["CLOUDFLARE_R2_", "R2_"],
  "pages.env": [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_PAGES_",
  ],
};
export const GITATTRIBUTES_LOCK_LINES = {
  text: "bun.lock text eol=lf linguist-generated=true",
  binary: "*.lockb binary diff=lockb linguist-generated=true",
} as const;

/** Upstream fixes in flight: reported as `waived` while the file exists, `notice` once it is gone. */
export const KNOWN_WAIVERS: readonly {
  code: GateCode;
  file: string;
  reason: string;
}[] = [
  {
    code: "ERR_NPMRC_FORBIDDEN",
    file: ".npmrc",
    reason:
      "registry-only .npmrc (no credentials) is deleted by upstream PR #194",
  },
];

/** The gate's own sources quote the patterns they police. */
export const SELF_EXEMPT_FILES: ReadonlySet<string> = new Set([
  "scripts/bun_native_rules.ts",
  "scripts/bun_native_rules.baseline.ts",
  "scripts/bun_native_rules.test.ts",
]);

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const TEXT_EXTENSIONS =
  /\.(?:[cm]?[jt]sx?|md|mdx|txt|json|jsonc|json5|toml|ya?ml|sh|bash|zsh|html|css|py|tla|cfg|mmd)$/;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

async function readText(
  view: RepoView,
  relativePath: string,
): Promise<string | null> {
  const file = Bun.file(join(view.root, relativePath));
  if (!(await file.exists())) return null;
  if (file.size > MAX_SCAN_BYTES) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function error(
  code: GateCode,
  rule: string,
  detail: string,
  file?: string,
  line?: number,
): GateFinding {
  return {
    code,
    rule,
    severity: "error",
    detail,
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
  };
}

function compareVersions(left: string, right: string): number {
  const leftParts = left
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  for (let partIndex = 0; partIndex < 3; partIndex += 1) {
    const delta = (leftParts[partIndex] ?? 0) - (rightParts[partIndex] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function nativeBunLintAvailable(bunVersion: string): boolean {
  return compareVersions(bunVersion, "1.5.0") >= 0;
}

export function parseEnvKeys(
  envText: string,
): Map<string, { line: number; hasValue: boolean; value: string }> {
  const keys = new Map<
    string,
    { line: number; hasValue: boolean; value: string }
  >();
  for (const [lineIndex, rawLine] of envText.split(/\r?\n/).entries()) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      rawLine,
    );
    if (match === null) continue;
    let value = (match[2] ?? "").trim();
    if (!value.startsWith('"') && !value.startsWith("'"))
      value = value.replace(/\s+#.*$/, "");
    value = value.replace(/^(['"])(.*)\1$/, "$2");
    keys.set(match[1] ?? "", {
      line: lineIndex + 1,
      hasValue: value.length > 0,
      value,
    });
  }
  return keys;
}

const lockfileRule: GateRule = {
  id: "lockfile",
  run: async (view) => {
    const rule = "lockfile";
    const findings: GateFinding[] = [];
    const lockText = await readText(view, "bun.lock");
    if (lockText === null) {
      findings.push(
        error(
          "ERR_LOCKFILE_MISSING",
          rule,
          "root text bun.lock is missing",
          "bun.lock",
        ),
      );
    } else {
      let lock: { lockfileVersion?: unknown; configVersion?: unknown };
      try {
        lock = Bun.JSONC.parse(lockText) as typeof lock;
      } catch (cause) {
        throw new GateRuleError(
          "ERR_LOCKFILE_VERSION",
          `bun.lock is not JSONC: ${String(cause)}`,
        );
      }
      if (lock.lockfileVersion !== EXPECTED_LOCKFILE_VERSION) {
        findings.push(
          error(
            "ERR_LOCKFILE_VERSION",
            rule,
            `lockfileVersion is ${JSON.stringify(lock.lockfileVersion)}, Bun 1.4.4 writes ${EXPECTED_LOCKFILE_VERSION}`,
            "bun.lock",
          ),
        );
      }
      if (lock.configVersion !== EXPECTED_LOCK_CONFIG_VERSION) {
        findings.push(
          error(
            "ERR_LINKER_NOT_ISOLATED",
            rule,
            `configVersion is ${JSON.stringify(lock.configVersion)}; ${EXPECTED_LOCK_CONFIG_VERSION} makes workspaces default to the isolated linker`,
            "bun.lock",
          ),
        );
      }
    }
    for (const file of view.files) {
      const name = basename(file);
      if (FOREIGN_LOCKFILE_NAMES.includes(name)) {
        findings.push(
          error(
            "ERR_FOREIGN_LOCKFILE",
            rule,
            `${name} is forbidden; bun.lock is the only lockfile`,
            file,
          ),
        );
      } else if (name === "bun.lock" && file !== "bun.lock") {
        findings.push(
          error(
            "ERR_NESTED_BUN_LOCK",
            rule,
            "only the root bun.lock may exist",
            file,
          ),
        );
      } else if (name === ".npmrc") {
        findings.push(
          error(
            "ERR_NPMRC_FORBIDDEN",
            rule,
            "registry config belongs in bunfig.toml [install.scopes]",
            file,
          ),
        );
      }
    }
    return findings;
  },
};

const CREDENTIAL_SURFACE = (file: string): boolean => {
  const name = basename(file);
  return (
    name === ".npmrc" ||
    name.startsWith(".npmrc.") ||
    name === ".yarnrc" ||
    name === ".yarnrc.yml" ||
    name === "bunfig.toml" ||
    name === "package.json" ||
    name === "bun.lock" ||
    /^\.env(?:\..+)?$/.test(name) ||
    name.endsWith(".env") ||
    (file.startsWith(".github/") && /\.ya?ml$/.test(name))
  );
};

/** Each pattern captures the secret slot; `$VAR`, `${VAR}`, `${{ secrets.X }}`, `%s`, and `<placeholder>` are templates, not secrets. */
const URL_CREDENTIAL_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  {
    label: "user:pass@",
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`<>()]+:([^\s/@"'`<>()]+)@/i,
  },
  { label: "/_auth=", pattern: /\/:?_auth\s*=\s*(\S*)/ },
  { label: "/_authToken=", pattern: /\/:?_authToken\s*=\s*(\S*)/ },
  { label: ":username=", pattern: /:username\s*=\s*(\S*)/ },
  { label: ":_password=", pattern: /:_password\s*=\s*(\S*)/ },
];

const TEMPLATED_SECRET = /^["']?(?:\$|%s|<[^>]+>)/;

export function credentialPatternHits(line: string): string[] {
  const hits: string[] = [];
  for (const { label, pattern } of URL_CREDENTIAL_PATTERNS) {
    const match = pattern.exec(line);
    if (match !== null && !TEMPLATED_SECRET.test(match[1] ?? ""))
      hits.push(label);
  }
  return hits;
}

const urlCredentialRule: GateRule = {
  id: "url-credentials",
  run: async (view) => {
    const findings: GateFinding[] = [];
    const surfaces = new Set([
      ...view.files.filter(CREDENTIAL_SURFACE),
      ...view.envFiles,
    ]);
    for (const file of [...surfaces].sort()) {
      const text = await readText(view, file);
      if (text === null) continue;
      for (const [lineIndex, line] of text.split("\n").entries()) {
        for (const label of credentialPatternHits(line)) {
          findings.push(
            error(
              "ERR_URL_EMBEDDED_CREDENTIAL",
              "url-credentials",
              `embedded credential pattern ${label}`,
              file,
              lineIndex + 1,
            ),
          );
        }
      }
    }
    return findings;
  },
};

/** A base64 Azure DevOps PAT: 84 chars encode to 112. npm base64-encodes NPM_PASSWORD again. */
export function isPreBase64AzurePat(value: string): boolean {
  if (value.length !== 112 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    return false;
  try {
    const decoded = atob(value);
    return decoded.length === 84 && /^[\x21-\x7e]+$/.test(decoded);
  } catch {
    return false;
  }
}

const envSecretsRule: GateRule = {
  id: "env-secrets",
  run: async (view) => {
    const findings: GateFinding[] = [];
    for (const file of [...view.envFiles].sort()) {
      const text = await readText(view, file);
      if (text === null) continue;
      const keys = parseEnvKeys(text);
      const password = keys.get("NPM_PASSWORD");
      if (password !== undefined && isPreBase64AzurePat(password.value)) {
        findings.push(
          error(
            "ERR_NPM_DOUBLE_BASE64_PAT",
            "env-secrets",
            "NPM_PASSWORD holds an already-base64 112-char Azure PAT; store the raw PAT",
            file,
            password.line,
          ),
        );
      }
      const r2 = keys.get("CLOUDFLARE_R2_API_TOKEN");
      const api = keys.get("CLOUDFLARE_API_TOKEN");
      if (r2?.hasValue === true && api?.hasValue === true) {
        findings.push(
          error(
            "ERR_CF_TOKEN_BLEED_10000",
            "env-secrets",
            "CLOUDFLARE_R2_API_TOKEN and CLOUDFLARE_API_TOKEN set in one file; split into r2.env and pages.env",
            file,
            Math.min(r2.line, api.line),
          ),
        );
      }
      const isolatedPrefixes = ISOLATED_SECRET_FILES[basename(file)];
      if (isolatedPrefixes !== undefined) {
        for (const [key, entry] of keys) {
          const owned = isolatedPrefixes.some((prefix) =>
            key.startsWith(prefix),
          );
          const foreign = Object.entries(ISOLATED_SECRET_FILES).some(
            ([otherName, prefixes]) =>
              otherName !== basename(file) &&
              prefixes.some((prefix) => key.startsWith(prefix)),
          );
          if (!owned && foreign && entry.hasValue) {
            findings.push(
              error(
                "ERR_CF_TOKEN_BLEED_10000",
                "env-secrets",
                `${key} belongs in another isolated secrets file`,
                file,
                entry.line,
              ),
            );
          }
        }
      }
    }
    return findings;
  },
};

const gitattributesRule: GateRule = {
  id: "gitattributes",
  run: async (view) => {
    const text = await readText(view, ".gitattributes");
    const rule = "gitattributes";
    if (text === null) {
      return [
        error(
          "ERR_GITATTRIBUTES_ORDER",
          rule,
          ".gitattributes is missing",
          ".gitattributes",
        ),
      ];
    }
    const lines = text
      .split("\n")
      .map((line) => line.trim().replace(/\s+/g, " "));
    const textAt = lines.indexOf(GITATTRIBUTES_LOCK_LINES.text);
    const binaryAt = lines.indexOf(GITATTRIBUTES_LOCK_LINES.binary);
    const findings: GateFinding[] = [];
    if (textAt === -1) {
      findings.push(
        error(
          "ERR_GITATTRIBUTES_ORDER",
          rule,
          `missing line: ${GITATTRIBUTES_LOCK_LINES.text}`,
          ".gitattributes",
        ),
      );
    }
    if (binaryAt === -1) {
      findings.push(
        error(
          "ERR_GITATTRIBUTES_ORDER",
          rule,
          `missing line: ${GITATTRIBUTES_LOCK_LINES.binary}`,
          ".gitattributes",
        ),
      );
    }
    if (textAt !== -1 && binaryAt !== -1 && textAt > binaryAt) {
      findings.push(
        error(
          "ERR_GITATTRIBUTES_ORDER",
          rule,
          "bun.lock text line must precede the *.lockb binary line",
          ".gitattributes",
          textAt + 1,
        ),
      );
    }
    for (const [lineIndex, line] of lines.entries()) {
      if (!line.startsWith("*.lockb ")) continue;
      const binaryToken = line.indexOf(" binary");
      const diffToken = line.indexOf(" diff=lockb");
      if (binaryToken === -1 || diffToken === -1 || binaryToken > diffToken) {
        findings.push(
          error(
            "ERR_GITATTRIBUTES_ORDER",
            rule,
            "*.lockb needs `binary` before `diff=lockb`",
            ".gitattributes",
            lineIndex + 1,
          ),
        );
      }
    }
    return findings;
  },
};

const GLOBAL_INSTALL =
  /\bbun\s+(?:i|install|add)\b[^\n]*?(?:\s-g\b|\s--global\b)/;

const globalInstallRule: GateRule = {
  id: "bun-global-install",
  run: async (view) => {
    const findings: GateFinding[] = [];
    for (const file of view.files) {
      if (SELF_EXEMPT_FILES.has(file) || !TEXT_EXTENSIONS.test(file)) continue;
      const text = await readText(view, file);
      if (text === null) continue;
      for (const [lineIndex, line] of text.split("\n").entries()) {
        if (GLOBAL_INSTALL.test(line)) {
          findings.push(
            error(
              "ERR_BUN_GLOBAL_INSTALL",
              "bun-global-install",
              "global bun install in scripts/docs",
              file,
              lineIndex + 1,
            ),
          );
        }
      }
    }
    return findings;
  },
};

function tomlCode(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
    const char = line[charIndex] ?? "";
    if (quote !== null) {
      if (char === "\\" && quote === '"') charIndex += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") break;
    out += char;
  }
  return out;
}

const CREDENTIAL_KEYS = new Set([
  "token",
  "password",
  "username",
  "_auth",
  "_authToken",
  "auth",
]);

const bunfigRule: GateRule = {
  id: "bunfig",
  run: async (view) => {
    const rule = "bunfig";
    const text = await readText(view, "bunfig.toml");
    if (text === null)
      return [
        error(
          "ERR_BUNFIG_INSTALL_FLOOR",
          rule,
          "root bunfig.toml is missing",
          "bunfig.toml",
        ),
      ];
    const findings: GateFinding[] = [];
    let openBraces = 0;
    for (const [lineIndex, line] of text.split("\n").entries()) {
      const code = tomlCode(line);
      for (const char of code) {
        if (char === "{") openBraces += 1;
        else if (char === "}") openBraces -= 1;
      }
      if (openBraces > 0) {
        findings.push(
          error(
            "ERR_BUNFIG_MULTILINE_INLINE_TABLE",
            rule,
            "inline tables must close on the line they open (TOML 1.0)",
            "bunfig.toml",
            lineIndex + 1,
          ),
        );
        openBraces = 0;
      }
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = Bun.TOML.parse(text) as Record<string, unknown>;
    } catch (cause) {
      return [
        ...findings,
        error(
          "ERR_BUNFIG_MULTILINE_INLINE_TABLE",
          rule,
          `bunfig.toml does not parse: ${String(cause)}`,
          "bunfig.toml",
        ),
      ];
    }
    const install = (parsed.install ?? {}) as Record<string, unknown>;
    if (install.exact !== true)
      findings.push(
        error(
          "ERR_BUNFIG_INSTALL_FLOOR",
          rule,
          "[install] exact must be true",
          "bunfig.toml",
        ),
      );
    if (install.ignoreScripts !== true) {
      findings.push(
        error(
          "ERR_BUNFIG_INSTALL_FLOOR",
          rule,
          "[install] ignoreScripts must be true",
          "bunfig.toml",
        ),
      );
    }
    if (install.linker !== undefined && install.linker !== "isolated") {
      findings.push(
        error(
          "ERR_LINKER_NOT_ISOLATED",
          rule,
          `[install] linker is ${JSON.stringify(install.linker)}`,
          "bunfig.toml",
        ),
      );
    }
    const lockfile = (install.lockfile ?? {}) as Record<string, unknown>;
    if (lockfile.print === "yarn") {
      findings.push(
        error(
          "ERR_BUNFIG_YARN_LOCKFILE",
          rule,
          '[install.lockfile] print = "yarn" is forbidden',
          "bunfig.toml",
        ),
      );
    }
    if (lockfile.save === false) {
      findings.push(
        error(
          "ERR_BUNFIG_YARN_LOCKFILE",
          rule,
          "[install.lockfile] save = false drops the text lockfile",
          "bunfig.toml",
        ),
      );
    }
    const visit = (node: unknown, path: string): void => {
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        const here = `${path}.${key}`;
        if (
          CREDENTIAL_KEYS.has(key) &&
          typeof value === "string" &&
          !/^\$[A-Z_][A-Z0-9_]*$/.test(value)
        ) {
          findings.push(
            error(
              "ERR_BUNFIG_LITERAL_CREDENTIAL",
              rule,
              `${here} must be a "$ENV_VAR" reference`,
              "bunfig.toml",
            ),
          );
        }
        if (
          typeof value === "string" &&
          credentialPatternHits(value).includes("user:pass@")
        ) {
          findings.push(
            error(
              "ERR_BUNFIG_LITERAL_CREDENTIAL",
              rule,
              `${here} embeds credentials in a URL`,
              "bunfig.toml",
            ),
          );
        }
        visit(value, here);
      }
    };
    visit(install, "install");
    return findings;
  },
};

type Manifest = {
  name?: unknown;
  private?: unknown;
  workspaces?: unknown;
  trustedDependencies?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: Record<string, string>;
  exports?: Record<string, string>;
  scripts?: Record<string, string>;
};

async function readManifest(
  view: RepoView,
  file: string,
): Promise<Manifest | null> {
  const text = await readText(view, file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as Manifest;
  } catch (cause) {
    throw new GateRuleError(
      "ERR_LEAF_MANIFEST",
      `${file} is not JSON: ${String(cause)}`,
    );
  }
}

const rootManifestRule: GateRule = {
  id: "root-manifest",
  run: async (view) => {
    const rule = "root-manifest";
    const manifest = await readManifest(view, "package.json");
    if (manifest === null)
      return [
        error(
          "ERR_ROOT_MANIFEST",
          rule,
          "root package.json is missing",
          "package.json",
        ),
      ];
    const findings: GateFinding[] = [];
    if (manifest.private !== true)
      findings.push(
        error(
          "ERR_ROOT_MANIFEST",
          rule,
          '"private" must be true',
          "package.json",
        ),
      );
    if (
      JSON.stringify(manifest.workspaces) !== JSON.stringify(["packages/*"])
    ) {
      findings.push(
        error(
          "ERR_ROOT_MANIFEST",
          rule,
          '"workspaces" must be ["packages/*"]',
          "package.json",
        ),
      );
    }
    if (
      !Array.isArray(manifest.trustedDependencies) ||
      manifest.trustedDependencies.length !== 0
    ) {
      findings.push(
        error(
          "ERR_ROOT_MANIFEST",
          rule,
          '"trustedDependencies" must be [] (opts out of Bun\'s default allow list)',
          "package.json",
        ),
      );
    }
    for (const field of ["dependencies", "devDependencies", "bin"] as const) {
      const allowed = new Set(ROOT_MANIFEST_FIELD_BASELINE[field]);
      for (const key of Object.keys(manifest[field] ?? {})) {
        if (!allowed.has(key)) {
          findings.push(
            error(
              "ERR_ROOT_MANIFEST",
              rule,
              `root "${field}" gained "${key}"; add it to a leaf package`,
              "package.json",
            ),
          );
        }
      }
    }
    return findings;
  },
};

const LINT_RECURSION = /\bbun\s+(?:run\s+)?lint\b/;

const leafManifestRule: GateRule = {
  id: "leaf-manifests",
  run: async (view, context) => {
    const rule = "leaf-manifests";
    const findings: GateFinding[] = [];
    const leafFiles = view.files
      .filter((file) => /^packages\/[^/]+\/package\.json$/.test(file))
      .sort();
    const names = new Map<string, string>();
    const native = nativeBunLintAvailable(context.bunVersion);
    for (const file of leafFiles) {
      const manifest = await readManifest(view, file);
      if (manifest === null) continue;
      const name = typeof manifest.name === "string" ? manifest.name : "";
      const owner = names.get(name);
      if (owner !== undefined)
        findings.push(
          error(
            "ERR_LEAF_MANIFEST",
            rule,
            `name ${name} duplicates ${owner}`,
            file,
          ),
        );
      names.set(name, file);
      if (
        !name.startsWith("@sportsdesk/") &&
        !LEAF_NAME_BASELINE.includes(name)
      ) {
        findings.push(
          error(
            "ERR_LEAF_MANIFEST",
            rule,
            `name ${JSON.stringify(name)} must be @sportsdesk/*`,
            file,
          ),
        );
      }
      if (manifest.devDependencies?.["@types/bun"] !== "1.4.4") {
        findings.push(
          error(
            "ERR_LEAF_MANIFEST",
            rule,
            'devDependencies["@types/bun"] must be exactly "1.4.4"',
            file,
          ),
        );
      }
      if (manifest.trustedDependencies !== undefined) {
        findings.push(
          error(
            "ERR_LEAF_MANIFEST",
            rule,
            "leaf trustedDependencies is forbidden; the root [] governs",
            file,
          ),
        );
      }
      for (const [scriptName, command] of Object.entries(
        manifest.scripts ?? {},
      )) {
        if (!scriptName.startsWith("lint")) continue;
        const callsBunLint = LINT_RECURSION.test(command);
        if (callsBunLint && (!native || !command.includes("--no-script"))) {
          findings.push(
            error(
              "ERR_LINT_SCRIPT_RECURSION",
              rule,
              native
                ? `scripts.${scriptName} calls bun lint without --no-script`
                : `scripts.${scriptName} calls bun lint, which Bun ${context.bunVersion} resolves to this package's own lint script`,
              file,
            ),
          );
        }
      }
      if (name === "@sportsdesk/ops") {
        for (const subpath of ["./tokens", "./tokens/css"]) {
          const target = manifest.exports?.[subpath];
          if (target === undefined) {
            findings.push(
              error(
                "ERR_LEAF_MANIFEST",
                rule,
                `exports["${subpath}"] is missing`,
                file,
              ),
            );
          } else if (!view.files.includes(join(file, "..", target))) {
            findings.push(
              error(
                "ERR_LEAF_MANIFEST",
                rule,
                `exports["${subpath}"] -> ${target} does not exist`,
                file,
              ),
            );
          }
        }
      }
      if (
        name === "@sportsdesk/nsh-desk" &&
        manifest.dependencies?.["@sportsdesk/ops"] !== "workspace:*"
      ) {
        findings.push(
          error(
            "ERR_LEAF_MANIFEST",
            rule,
            'dependencies["@sportsdesk/ops"] must be "workspace:*"',
            file,
          ),
        );
      }
    }
    for (const required of ["@sportsdesk/ops", "@sportsdesk/nsh-desk"]) {
      if (!names.has(required))
        findings.push(
          error(
            "ERR_LEAF_MANIFEST",
            rule,
            `no leaf package is named ${required}`,
          ),
        );
    }
    return findings;
  },
};

function ratchet(
  code: GateCode,
  rule: string,
  counts: ReadonlyMap<string, number>,
  baseline: Readonly<Record<string, number>>,
  describe: (file: string, count: number, allowed: number) => string,
): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const [file, count] of [...counts].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed)
      findings.push(error(code, rule, describe(file, count, allowed), file));
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = counts.get(file) ?? 0;
    if (count < allowed) {
      findings.push({
        code,
        rule,
        severity: "notice",
        file,
        detail: `baseline ${allowed} -> ${count}; lower it in scripts/bun_native_rules.baseline.ts`,
      });
    }
  }
  return findings;
}

const DODSPINE_LEAK = /DOD6|v5\.4|0x444f4436/gi;
const FROZEN_DECLARATION = /FROZEN_DODBIN_MAGIC_LE32\s*=\s*0x444f4436/i;

export async function countDodSpineLeaks(
  view: RepoView,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const file of view.files) {
    if (SELF_EXEMPT_FILES.has(file)) continue;
    let count = /dod6|v54/i.test(file) ? 1 : 0;
    if (TEXT_EXTENSIONS.test(file) || /\.(?:csv|svg)$/.test(file)) {
      const text = await readText(view, file);
      for (const line of text?.split("\n") ?? []) {
        if (FROZEN_DECLARATION.test(line)) continue;
        count += line.match(DODSPINE_LEAK)?.length ?? 0;
      }
    }
    if (count > 0) counts.set(file, count);
  }
  return counts;
}

const dodSpineRule: GateRule = {
  id: "dodspine-naming",
  run: async (view) =>
    ratchet(
      "ERR_DODSPINE_NAMING_LEAK",
      "dodspine-naming",
      await countDodSpineLeaks(view),
      DODSPINE_LEAK_BASELINE,
      (file, count, allowed) =>
        `${count} DOD6/v5.4/magic-literal mention(s) (baseline ${allowed}); use DodSpine naming and FROZEN_DODBIN_MAGIC_LE32`,
    ),
};

const SHORT_LOOP_INDEX = /\bfor\s*\(\s*(?:let|const|var)\s+[ijk]\b/g;

export async function countLoopIndices(
  view: RepoView,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const file of view.files) {
    if (SELF_EXEMPT_FILES.has(file) || !SOURCE_EXTENSIONS.test(file)) continue;
    const text = await readText(view, file);
    const count = text?.match(SHORT_LOOP_INDEX)?.length ?? 0;
    if (count > 0) counts.set(file, count);
  }
  return counts;
}

const loopIndexRule: GateRule = {
  id: "loop-indices",
  run: async (view) =>
    ratchet(
      "ERR_LOOP_INDEX_NOT_DESCRIPTIVE",
      "loop-indices",
      await countLoopIndices(view),
      LOOP_INDEX_BASELINE,
      (file, count, allowed) =>
        `${count} single-letter loop index(es) i/j/k (baseline ${allowed}); name what it indexes`,
    ),
};

const BUN_GITHUB_LINK =
  /https?:\/\/github\.com\/oven-sh\/bun(?:\/[^\s)"'`<>\]|]*)?/g;
const NON_SOURCE_BUN_LINK =
  /^https?:\/\/github\.com\/oven-sh\/bun(?:\/?$|\/(?:releases|issues|pull|discussions|compare|actions|labels|milestone|wiki|security)(?:\/|$|#|\?))/;
const PINNED_LEAF_BLOB = new RegExp(
  `^https://github\\.com/oven-sh/bun/blob/${PINNED_BUN_SHA}/[^\\s#?]*[^/\\s#?](?:#[^\\s]*)?$`,
);

export function classifyBunLink(url: string): "exempt" | "pinned" | "unpinned" {
  const trimmed = url.replace(/[.,;:]+$/, "");
  if (NON_SOURCE_BUN_LINK.test(trimmed)) return "exempt";
  return PINNED_LEAF_BLOB.test(trimmed) ? "pinned" : "unpinned";
}

const bunSourceUrlRule: GateRule = {
  id: "bun-source-urls",
  run: async (view) => {
    const findings: GateFinding[] = [];
    for (const file of view.files) {
      if (SELF_EXEMPT_FILES.has(file) || !TEXT_EXTENSIONS.test(file)) continue;
      const text = await readText(view, file);
      if (text === null || !text.includes("oven-sh/bun")) continue;
      for (const [lineIndex, line] of text.split("\n").entries()) {
        for (const match of line.matchAll(BUN_GITHUB_LINK)) {
          if (classifyBunLink(match[0]) === "unpinned") {
            findings.push(
              error(
                "ERR_BUN_SOURCE_URL_NOT_PINNED",
                "bun-source-urls",
                `${match[0]} must be a leaf blob URL at ${PINNED_BUN_SHA}`,
                file,
                lineIndex + 1,
              ),
            );
          }
        }
      }
    }
    return findings;
  },
};

/** Always forbidden in the working tree (tracked or untracked-unignored). */
export const FORBIDDEN_DATA_EXTENSIONS =
  /\.(?:sqlite3?|db|db-wal|db-shm|sqlite-wal|sqlite-shm)$/i;
/** JSON that is configuration, not data: allowed anywhere. */
export const CONFIG_JSON_NAMES =
  /^(?:package\.json|tsconfig(?:\.[\w-]+)?\.json|\.oxlintrc(?:\.[\w-]+)?\.json|skills-lock\.json|nsh\.json|theme\.json|launch\.json|settings\.json|extensions\.json)$/;
/** Trees whose JSON is a committed contract: fixtures, evidence, schemas, specs, locales, config. */
export const CONTRACT_JSON_TREES =
  /^(?:tests\/|docs\/evidence\/|schema\/|verification\/|config\/|[^/]+\/locale\/|\.cursor\/|\.agents\/|\.github\/)/;

export function classifyJsonArtifact(
  file: string,
): "allowed" | "artifact" | "forbidden-data" | "other" {
  if (FORBIDDEN_DATA_EXTENSIONS.test(file)) return "forbidden-data";
  if (!/\.json$/i.test(file) || FOREIGN_LOCKFILE_NAMES.includes(basename(file)))
    return "other";
  if (CONFIG_JSON_NAMES.test(basename(file)) || CONTRACT_JSON_TREES.test(file))
    return "allowed";
  return "artifact";
}

const jsonArtifactRule: GateRule = {
  id: "local-json-artifacts",
  run: async (view) => {
    const findings: GateFinding[] = [];
    const baseline = new Set(JSON_ARTIFACT_BASELINE);
    for (const file of view.files) {
      const kind = classifyJsonArtifact(file);
      if (kind === "forbidden-data") {
        findings.push(
          error(
            "ERR_OPS_LOCAL_JSON_FORBIDDEN",
            "local-json-artifacts",
            "SQLite/db files never live in the tree; use R2 or a gitignored path",
            file,
          ),
        );
      } else if (kind === "artifact" && !baseline.has(file)) {
        findings.push(
          error(
            "ERR_OPS_LOCAL_JSON_FORBIDDEN",
            "local-json-artifacts",
            "generated/data JSON outside config and contract trees; publish to R2 or gitignore it",
            file,
          ),
        );
      }
    }
    for (const file of baseline) {
      if (!view.files.includes(file)) {
        findings.push({
          code: "ERR_OPS_LOCAL_JSON_FORBIDDEN",
          rule: "local-json-artifacts",
          severity: "notice",
          file,
          detail: "gone; drop it from JSON_ARTIFACT_BASELINE",
        });
      }
    }
    return findings;
  },
};

export const ALL_RULES: readonly GateRule[] = [
  lockfileRule,
  urlCredentialRule,
  envSecretsRule,
  gitattributesRule,
  globalInstallRule,
  bunfigRule,
  rootManifestRule,
  leafManifestRule,
  dodSpineRule,
  loopIndexRule,
  bunSourceUrlRule,
  jsonArtifactRule,
];

export function applyWaivers(
  findings: readonly GateFinding[],
  view: RepoView,
): GateFinding[] {
  const out = findings.map((finding) => {
    const waiver = KNOWN_WAIVERS.find(
      (entry) => entry.code === finding.code && entry.file === finding.file,
    );
    return waiver === undefined || finding.severity !== "error"
      ? finding
      : {
          ...finding,
          severity: "waived" as const,
          detail: `${finding.detail} [waived: ${waiver.reason}]`,
        };
  });
  for (const waiver of KNOWN_WAIVERS) {
    if (!view.files.includes(waiver.file)) {
      out.push({
        code: waiver.code,
        rule: "waivers",
        severity: "notice",
        file: waiver.file,
        detail: "waived file is gone; delete the waiver",
      });
    }
  }
  return out;
}

export async function runRules(
  view: RepoView,
  context: RuleContext,
  rules: readonly GateRule[] = ALL_RULES,
): Promise<GateFinding[]> {
  const results = await Promise.all(
    rules.map((rule) => rule.run(view, context)),
  );
  return applyWaivers(results.flat(), view);
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(root: string, relative: string, out: string[]): void {
  for (const entry of readdirSync(join(root, relative), {
    withFileTypes: true,
  })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
}

const ENV_FILE = (name: string): boolean =>
  /^\.env(?:\..+)?$/.test(name) || name.endsWith(".env");

function findEnvFiles(root: string): string[] {
  const found: string[] = [];
  const scan = (relative: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(join(root, relative));
    } catch {
      return;
    }
    for (const name of entries) {
      const child = relative === "" ? name : `${relative}/${name}`;
      if (ENV_FILE(name) && statSync(join(root, child)).isFile())
        found.push(child);
    }
  };
  scan("");
  scan("config");
  try {
    for (const name of readdirSync(join(root, "packages")))
      scan(`packages/${name}`);
  } catch {
    return found.sort();
  }
  return found.sort();
}

export function repoViewFromDirectory(root: string): RepoView {
  const files: string[] = [];
  walk(root, "", files);
  return { root, files: files.sort(), envFiles: findEnvFiles(root) };
}

export function repoViewFromGit(root: string): RepoView {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new GateRuleError(
      "ERR_LOCKFILE_MISSING",
      `git ls-files failed: ${result.stderr.toString().trim()}`,
    );
  }
  const listed = result.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0);
  const onDisk = listed.filter((file) => {
    try {
      return statSync(join(root, file)).isFile();
    } catch {
      return false;
    }
  });
  return {
    root,
    files: [...new Set(onDisk)].sort(),
    envFiles: findEnvFiles(root),
  };
}
