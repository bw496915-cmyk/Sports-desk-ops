/**
 * @file lib/npm_registry.ts
 * @description Resolve which registry a package name uses, from `.npmrc` text.
 *
 * `.npmrc` is line-oriented and last-one-wins for `registry=`, while `@scope:registry=` routes a scope.
 * Parsing it here means the check command and any future publish script agree on the same rules instead
 * of re-implementing them.
 */

export interface NpmrcConfig {
  readonly defaultRegistry: string | null;
  readonly scopes: Readonly<Record<string, string>>;
}

export function parseNpmrc(text: string): NpmrcConfig {
  let defaultRegistry: string | null = null;
  const scopes: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value === "") continue;

    if (key === "registry") {
      defaultRegistry = value;
      continue;
    }
    const scoped = /^(@[^:]+):registry$/.exec(key);
    if (scoped !== null) scopes[scoped[1]!] = value;
  }

  return { defaultRegistry, scopes };
}

/** `@scope/name` → the scope registry, otherwise the default. */
export function registryFor(
  packageName: string,
  config: NpmrcConfig,
): string | null {
  const scope = packageName.startsWith("@")
    ? packageName.slice(0, packageName.indexOf("/"))
    : "";
  if (scope !== "" && scope in config.scopes) return config.scopes[scope]!;
  return config.defaultRegistry;
}

/** Host part of a registry URL, for display without credentials. */
export function registryHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}
