/**
 * @file lib/env_audit.ts
 * @description Audit the local `.env`: which keys are secret, and whether any value leaked into a
 * tracked file.
 *
 * Values never leave this module — the result carries names and paths, never secrets. That constraint
 * is the point: an audit that prints what it is protecting is another leak.
 */

export interface EnvEntry {
  readonly name: string;
  readonly value: string;
  readonly isSecret: boolean;
}

export interface TrackedFile {
  readonly path: string;
  readonly text: string;
}

/** Public projection: names and classification only, never values. */
export interface EnvEntryView {
  readonly name: string;
  readonly isSecret: boolean;
}

export interface EnvAuditResult {
  readonly entries: readonly EnvEntryView[];
  /** Tracked files whose content contains a secret value. */
  readonly leaks: readonly { path: string; name: string }[];
  /** Secret names only, for reporting. */
  readonly secretNames: readonly string[];
  readonly nonSecretNames: readonly string[];
  /** True when a tracked file is `.env` itself. */
  readonly envTracked: boolean;
}

const SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

/** Minimum length before a value is worth searching for; short values match by accident. */
const MIN_LEAK_LENGTH = 12;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/**
 * Parse dotenv content.
 *
 * Handles `export `, `#` comments, single/double quotes, and inline comments after an unquoted value.
 * Blank values are kept: an empty secret is still a declared key.
 */
export function parseEnvFile(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ")
      ? line.slice(7).trim()
      : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const name = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (
      value.startsWith("'") &&
      value.endsWith("'") &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    entries.push({ name, value, isSecret: isSecretName(name) });
  }
  return entries;
}

export function auditEnv(
  entries: readonly EnvEntry[],
  files: readonly TrackedFile[],
): EnvAuditResult {
  const secrets = entries.filter(
    (entry) => entry.isSecret && entry.value.length >= MIN_LEAK_LENGTH,
  );
  const leaks: Array<{ path: string; name: string }> = [];

  for (const file of files) {
    for (const secret of secrets) {
      if (file.text.includes(secret.value))
        leaks.push({ path: file.path, name: secret.name });
    }
  }

  return {
    // Values are dropped here so no caller can accidentally serialize a secret.
    entries: entries.map((entry) => ({
      name: entry.name,
      isSecret: entry.isSecret,
    })),
    leaks,
    secretNames: entries
      .filter((entry) => entry.isSecret)
      .map((entry) => entry.name),
    nonSecretNames: entries
      .filter((entry) => !entry.isSecret)
      .map((entry) => entry.name),
    envTracked: files.some(
      (file) => file.path === ".env" || file.path.endsWith("/.env"),
    ),
  };
}

/** Permissions string (e.g. `644`) when the file is readable by group or others. */
export function permissionWarning(mode: number): string | null {
  if ((mode & 0o077) === 0) return null;
  const octal = (mode & 0o777).toString(8);
  return `.env is mode ${octal}: readable by group/others, should be 600`;
}
