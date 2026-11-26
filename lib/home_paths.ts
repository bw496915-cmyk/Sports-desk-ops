/**
 * @file home_paths.ts
 * @description Find the current operator's home directory baked into tracked files.
 *
 * A tracked file that names `/Users/<name>` or `/home/<name>` leaks an account name and cannot
 * resolve on another checkout. The needle is not a pattern: it is *this machine's* `homedir()`, so
 * the check is exact and deterministic per operator. Test fixtures that use obvious placeholders
 * (`/Users/someone`, `/Users/me`, `/home/ci`) are not anyone's real home and stay allowed by
 * construction — the rule is "do not hardcode the operator's home", not "never write `/Users/`".
 *
 * The allowlist is empty by design: portable `~/` paths are expanded at runtime via
 * `expandHomePath()`, so zero tracked files hardcode any operator's home directory.
 *
 * A second rule covers the other half: a *foreign* home — `/Users/<name>` for a name that is neither
 * this operator nor a documented synthetic placeholder. A real person's name in a fixture is a
 * privacy leak even though it resolves fine on their machine.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface HomePathHit {
  readonly file: string;
  readonly line: number;
  /** The home directory that matched. */
  readonly match: string;
}

export interface HomePathAllowance {
  readonly path: string;
  readonly reason: string;
}

/**
 * Files that may keep a literal home path, with the reason the leak is not fixable.
 * Empty by design: use portable `~/` paths expanded via `expandHomePath()` instead.
 */
export const HOME_PATH_ALLOWLIST: readonly HomePathAllowance[] = [];

export function isHomePathAllowlisted(
  file: string,
  allowlist: readonly HomePathAllowance[] = HOME_PATH_ALLOWLIST,
): boolean {
  return allowlist.some((entry) => entry.path === file);
}

/** Expand a leading `~` or `~/` (or `~\`) against `home`, leaving all other paths untouched. */
export function expandHomePath(
  filePath: string,
  home: string = homedir(),
): string {
  if (filePath === "~") return home;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

/**
 * The spellings of `home` that can appear in a text file: the raw POSIX path and, on Windows, the
 * backslash form. Returned longest-first so a longer form is matched before a shorter prefix.
 */
export function homePathNeedles(home: string = homedir()): string[] {
  const needles = new Set<string>();
  if (home.length > 0) {
    needles.add(home);
    needles.add(home.replace(/\//g, "\\"));
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

/** Every occurrence of the operator home in `text`, one hit per line per needle. */
export function findHomePaths(
  file: string,
  text: string,
  home: string = homedir(),
): HomePathHit[] {
  const needles = homePathNeedles(home);
  if (needles.length === 0) return [];
  const hits: HomePathHit[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    for (const needle of needles) {
      if (line.includes(needle))
        hits.push({ file, line: index + 1, match: needle });
    }
  }
  return hits;
}

/**
 * Synthetic account names allowed in fixtures. A real person's name must never join this list: the
 * point of a placeholder is that it cannot identify anyone.
 */
export const HOME_PATH_PLACEHOLDER_USERS: readonly string[] = [
  "someone",
  "me",
  "x",
  "dev",
  "operator",
  "realperson",
  "ci",
  "user",
  "example",
];

const USER_HOME_RE = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;
const WINDOWS_USER_HOME_RE = /[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)/g;

function ownAccountName(home: string): string {
  return (
    home
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .pop() ?? ""
  );
}

/**
 * Home paths belonging to somebody else: a name that is neither the current operator nor a
 * placeholder. Placeholders are matched case-insensitively; an all-dots name is prose about a path
 * (`/Users/...`), not an account.
 */
export function findForeignHomePaths(
  file: string,
  text: string,
  home: string = homedir(),
): HomePathHit[] {
  const own = ownAccountName(home);
  const placeholders = new Set(
    HOME_PATH_PLACEHOLDER_USERS.map((name) => name.toLowerCase()),
  );
  const hits: HomePathHit[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    for (const pattern of [USER_HOME_RE, WINDOWS_USER_HOME_RE]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const name = match[1]!;
        if (name === own) continue;
        if (/^\.+$/.test(name)) continue;
        if (placeholders.has(name.toLowerCase())) continue;
        hits.push({ file, line: index + 1, match: name });
      }
    }
  }
  return hits;
}

export interface HomePathScanResult {
  readonly violations: readonly HomePathHit[];
  /** Home paths naming someone other than the operator or a documented placeholder. */
  readonly foreign: readonly HomePathHit[];
  readonly allowed: readonly HomePathHit[];
  readonly scannedFiles: number;
}

/**
 * Scan tracked files. `readFile` returns null for a path that is not UTF-8 text (the caller skips
 * it); the scanner never reads the filesystem itself, so a test can feed it fixtures.
 */
export function scanHomePaths(
  files: readonly string[],
  readFile: (file: string) => string | null,
  home: string = homedir(),
  allowlist: readonly HomePathAllowance[] = HOME_PATH_ALLOWLIST,
): HomePathScanResult {
  const violations: HomePathHit[] = [];
  const foreign: HomePathHit[] = [];
  const allowed: HomePathHit[] = [];
  let scannedFiles = 0;
  for (const file of files) {
    const text = readFile(file);
    if (text === null) continue;
    scannedFiles++;
    const hits = findHomePaths(file, text, home);
    const foreignHits = findForeignHomePaths(file, text, home);
    if (isHomePathAllowlisted(file, allowlist)) {
      allowed.push(...hits, ...foreignHits);
      continue;
    }
    violations.push(...hits);
    foreign.push(...foreignHits);
  }
  return { violations, foreign, allowed, scannedFiles };
}
