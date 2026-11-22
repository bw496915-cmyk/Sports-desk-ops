/**
 * @file install_security_scanner.ts
 * @description Install-time gate for the event-stream incident.
 *
 * `event-stream@3.3.6` depended on `flatmap-stream@0.1.1`, which was the
 * payload. npm has since unpublished `3.3.6`. The version check is
 * `Bun.semver.satisfies(version, ">=3.3.6 <4.0.0")`, the same parser `bun
 * install` uses. It returns false for a prerelease, a non-ASCII string, and a
 * `file:` / `github:` / `git+` specifier, so those are not a second guard.
 * `Bun.semver.order` compares two versions and throws when either is not
 * semver. `flatmap-stream` is fatal at every version.
 *
 * A resolved `4.0.1` is not enough. The tarball has to be the public npm path
 * for that same version (`registry.npmjs.org` or `registry.yarnpkg.com`).
 * `requestedRange` is fatal when every release `satisfies` accepts sits inside
 * `>=3.3.6 <4.0.0`. A range with no parseable part, including `*`, `latest`,
 * and `file:`, behaves like `*` and stays clear. A `patch:` pin replaces the
 * registry bytes and stays fatal.
 *
 * `packagesFromLockfile` replays a `bun.lock` text lockfile through the same
 * check. A `.tgz` resolution URL becomes `tarball`. A dependency edge on
 * `flatmap-stream`, or on `event-stream` in that interval, is fatal even when
 * the lockfile has no package entry for it. A `patchedDependencies` entry, a
 * catalog pin, or an override of either name is fatal too: the registry
 * version no longer describes the bytes. A non-empty registry URL on an
 * `event-stream` row is the tarball host, so a private registry cannot wear
 * a safe version. An empty resolution uses the project default registry from
 * `bunfig.toml` `[install] registry` or an unscoped `.npmrc` `registry`.
 * `scan` reads `bun.lock`, the root `package.json`, and each workspace
 * manifest from the working directory when they are present. Names are
 * compared with format characters and whitespace removed.
 *
 * Enable with the project bunfig key `[install.security] scanner`. That key
 * is not one of the machine-owned install keys.
 */

import path from "node:path";
import {
  canonicalPackageName,
  checkExtendedOfflinePolicy,
  EXTENDED_DENYLIST,
  openScannerCache,
  parseCsvEnv,
  parseCvssV3BaseScore,
  queryOsvBatch,
  runOsvLayer,
  scoreToSeverity,
  type ExtendedOfflineOptions,
} from "../lib/install_security_layers.ts";

export {
  canonicalPackageName,
  checkExtendedOfflinePolicy,
  EXTENDED_DENYLIST,
  openScannerCache,
  parseCvssV3BaseScore,
  queryOsvBatch,
  scoreToSeverity,
};

const INCIDENT_URL =
  "https://blog.npmjs.org/post/180565383195/details-about-the-event-stream-incident";

/** Registry versions that shipped the `flatmap-stream` dependency. */
export const EVENT_STREAM_COMPROMISED_RANGE = ">=3.3.6 <4.0.0";

const REGISTRY_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+].*)?$/;

const TARBALL_VERSION =
  /event-stream-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?)\.tgz(?=[?#]|$)/g;

export function registryCore(version: string): string | null {
  const match = REGISTRY_VERSION.exec(version);
  if (match === null) return null;
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  return `${major}.${minor}.${patch}`;
}

function versionInCompromise(version: string): boolean {
  return Bun.semver.satisfies(version, EVENT_STREAM_COMPROMISED_RANGE);
}

/** `order` throws when either side is not semver. A throw is not a match. */
function sameVersion(left: string, right: string): boolean {
  try {
    return Bun.semver.order(left, right) === 0;
  } catch {
    return false;
  }
}

/**
 * Releases the boundary list does not already name. `>=3.9.1 <3.9.2` has to
 * be asked of `satisfies`, not reconstructed with a comparator parser.
 */
const RELEASE_PROBES = [
  "0.0.0",
  "3.0.0",
  "3.3.0",
  "3.3.5",
  "3.3.6",
  "3.3.7",
  "3.3.8",
  "3.4.0",
  "3.9.0",
  "3.9.9",
  "3.10.0",
  "3.11.0",
  "4.0.0",
  "4.0.1",
] as const;

const MENTIONED_RELEASE =
  /(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*|x|X|\*))?(?:\.(?:0|[1-9][0-9]*|x|X|\*))?/g;

function mentionedReleases(range: string): string[] {
  const found: string[] = [];
  for (const match of range.matchAll(MENTIONED_RELEASE)) {
    const parts = match[0].split(".");
    const major = parts[0];
    const minor = parts[1];
    const patch = parts[2];
    if (major === undefined) continue;
    const minorNum =
      minor === undefined || minor === "x" || minor === "X" || minor === "*"
        ? "0"
        : minor;
    const patchNum =
      patch === undefined || patch === "x" || patch === "X" || patch === "*"
        ? "0"
        : patch;
    found.push(`${major}.${minorNum}.${patchNum}`);
  }
  return found;
}

/**
 * True when `satisfies` accepts at least one release and every accepted
 * release is inside `>=3.3.6 <4.0.0`. A range with no parseable part acts
 * like `*` and is not exclusive.
 */
export function rangeSelectsOnlyCompromise(range: string): boolean {
  const probes = new Set<string>([
    ...RELEASE_PROBES,
    ...mentionedReleases(range),
  ]);
  let selected = false;
  for (const version of probes) {
    if (!Bun.semver.satisfies(version, range)) continue;
    if (!versionInCompromise(version)) return false;
    selected = true;
  }
  return selected;
}

/** Last `event-stream-<semver>.tgz` core in a tarball URL or path. */
export function tarballCore(tarball: string): string | null {
  let core: string | null = null;
  TARBALL_VERSION.lastIndex = 0;
  for (const match of tarball.matchAll(TARBALL_VERSION)) {
    const named = match[1];
    if (named === undefined) continue;
    const next = registryCore(named);
    if (next !== null) core = next;
  }
  return core;
}

function fatal(
  pkg: Bun.Security.Package,
  description: string,
): Bun.Security.Advisory {
  return {
    level: "fatal",
    package: pkg.name,
    url: INCIDENT_URL,
    description,
  };
}

const PUBLIC_NPM_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
]);

const TARBALL_PATH =
  /^\/event-stream\/-\/event-stream-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?)\.tgz$/;

function canonicalIncident(
  name: string,
): "event-stream" | "flatmap-stream" | null {
  const folded = name
    .normalize("NFKC")
    .replace(/[\p{Cf}\s]/gu, "")
    .toLowerCase();
  if (folded === "event-stream" || folded === "flatmap-stream") return folded;
  return null;
}

function tarballAdvisory(
  pkg: Bun.Security.Package,
): Bun.Security.Advisory | null {
  const tarball = pkg.tarball;
  if (tarball.length === 0) return null;
  let named: string | null = null;
  try {
    const url = new URL(tarball);
    const match =
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      PUBLIC_NPM_HOSTS.has(url.hostname)
        ? TARBALL_PATH.exec(url.pathname)
        : null;
    named = match?.[1] ?? null;
  } catch {
    named = null;
  }
  if (named === null) {
    return fatal(
      pkg,
      `event-stream@${pkg.version} tarball ${tarball} is not a public npm tarball`,
    );
  }
  if (versionInCompromise(named)) {
    return fatal(
      pkg,
      `event-stream tarball ${tarball} names ${named}, which is in ${EVENT_STREAM_COMPROMISED_RANGE}`,
    );
  }
  if (!sameVersion(named, pkg.version)) {
    return fatal(
      pkg,
      `event-stream tarball ${tarball} names ${named}, which does not match resolved ${pkg.version}`,
    );
  }
  return null;
}

function replacesRegistryBytes(range: string): boolean {
  return range.startsWith("patch:");
}

function requestedRangeAdvisory(
  pkg: Bun.Security.Package,
): Bun.Security.Advisory | null {
  const requestedRange = pkg.requestedRange;
  if (requestedRange.length === 0) return null;
  if (replacesRegistryBytes(requestedRange)) {
    return fatal(
      pkg,
      `event-stream requested ${requestedRange}, which replaces the registry bytes`,
    );
  }
  if (rangeSelectsOnlyCompromise(requestedRange)) {
    return fatal(
      pkg,
      `event-stream requested ${requestedRange}, which selects only ${EVENT_STREAM_COMPROMISED_RANGE}`,
    );
  }
  return null;
}

export function advisoryFor(
  pkg: Bun.Security.Package,
): Bun.Security.Advisory | null {
  const incident = canonicalIncident(pkg.name);
  if (incident === "flatmap-stream") {
    return fatal(
      pkg,
      `flatmap-stream@${pkg.version} is the unpublished payload from the event-stream 3.3.6 incident`,
    );
  }
  if (incident !== "event-stream") return null;
  if (versionInCompromise(pkg.version)) {
    return fatal(
      pkg,
      `event-stream@${pkg.version} is in ${EVENT_STREAM_COMPROMISED_RANGE}, which shipped flatmap-stream`,
    );
  }
  return tarballAdvisory(pkg) ?? requestedRangeAdvisory(pkg);
}

const RANGE_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

interface LockMeta {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

function splitSpec(spec: string): { name: string; version: string } {
  const alias = spec.lastIndexOf("@npm:");
  const target = alias === -1 ? spec : spec.slice(alias + "@npm:".length);
  const at = target.lastIndexOf("@");
  if (at <= 0) return { name: target, version: "" };
  return { name: target.slice(0, at), version: target.slice(at + 1) };
}

function addRanges(
  target: Map<string, string[]>,
  deps: Record<string, unknown> | undefined,
): void {
  if (deps === undefined) return;
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range !== "string") continue;
    const key = canonicalIncident(name) ?? name;
    const list = target.get(key);
    if (list === undefined) target.set(key, [range]);
    else list.push(range);
  }
}

function requestedRangeFor(name: string, ranges: readonly string[]): string {
  if (name !== "event-stream" && name !== "flatmap-stream") {
    return ranges[0] ?? "";
  }
  for (const range of ranges) {
    if (replacesRegistryBytes(range) || rangeSelectsOnlyCompromise(range)) {
      return range;
    }
  }
  return ranges[0] ?? "";
}

function addIncidentPin(
  ranges: Map<string, string[]>,
  name: string,
  range: string,
): void {
  const incident = canonicalIncident(name);
  if (incident === null) return;
  addRanges(ranges, { [incident]: range });
}

function walkPins(
  ranges: Map<string, string[]>,
  value: unknown,
  key: string | null,
): void {
  if (typeof value === "string") {
    if (key !== null) addIncidentPin(ranges, key, value);
    if (value.startsWith("npm:")) {
      const { name, version } = splitSpec(`alias@${value}`);
      if (canonicalIncident(name) !== null) {
        addIncidentPin(ranges, name, version.length > 0 ? version : value);
      }
    }
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  for (const [childKey, child] of Object.entries(value)) {
    walkPins(ranges, child, childKey);
  }
}

interface PinSource {
  catalog?: Record<string, unknown>;
  catalogs?: Record<string, unknown>;
  overrides?: unknown;
  patchedDependencies?: Record<string, unknown>;
}

function collectPins(ranges: Map<string, string[]>, doc: PinSource): void {
  if (typeof doc.catalog === "object" && doc.catalog !== null) {
    for (const [name, range] of Object.entries(doc.catalog)) {
      if (typeof range === "string") addIncidentPin(ranges, name, range);
    }
  }
  for (const catalog of Object.values(doc.catalogs ?? {})) {
    if (typeof catalog !== "object" || catalog === null) continue;
    for (const [name, range] of Object.entries(catalog)) {
      if (typeof range === "string") addIncidentPin(ranges, name, range);
    }
  }
  walkPins(ranges, doc.overrides, null);
  for (const [spec, patchPath] of Object.entries(
    doc.patchedDependencies ?? {},
  )) {
    if (typeof patchPath !== "string") continue;
    const { name } = splitSpec(spec);
    addIncidentPin(ranges, name, `patch:${patchPath}`);
  }
}

/** A registry base URL is the host of the tarball Bun will download. */
function eventStreamResolution(version: string, resolution: string): string {
  if (resolution.length === 0 || resolution.includes(".tgz")) return resolution;
  const core = registryCore(version);
  if (core === null) return resolution;
  try {
    const url = new URL(resolution);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      return resolution;
  } catch {
    return resolution;
  }
  const base = resolution.endsWith("/") ? resolution : `${resolution}/`;
  return `${base}event-stream/-/event-stream-${core}.tgz`;
}

function unseenIncidentPackages(
  ranges: Map<string, string[]>,
  seen: ReadonlySet<string>,
): Bun.Security.Package[] {
  const packages: Bun.Security.Package[] = [];
  for (const incident of ["flatmap-stream", "event-stream"] as const) {
    if (seen.has(incident)) continue;
    const recorded = ranges.get(incident);
    if (recorded === undefined) continue;
    const requestedRange = requestedRangeFor(incident, recorded);
    if (
      incident === "event-stream" &&
      !replacesRegistryBytes(requestedRange) &&
      !rangeSelectsOnlyCompromise(requestedRange)
    ) {
      continue;
    }
    packages.push({
      name: incident,
      version: requestedRange,
      requestedRange,
      tarball: "",
    });
  }
  return packages;
}

const PUBLIC_REGISTRY_HOSTS = PUBLIC_NPM_HOSTS;

function chooseDefaultRegistry(candidates: readonly string[]): string {
  const set = candidates
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return set.find((item) => !isPublicRegistry(item)) ?? set[0] ?? "";
}

function isPublicRegistry(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && PUBLIC_REGISTRY_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Unscoped default registry. A scoped `.npmrc` line does not apply to `event-stream`. */
export function defaultRegistryFromProjectFiles(
  bunfigText: string | null,
  npmrcText: string | null,
): string {
  const candidates: string[] = [];
  if (bunfigText !== null) {
    const parsed = Bun.TOML.parse(bunfigText) as {
      install?: { registry?: unknown };
    };
    if (typeof parsed.install?.registry === "string") {
      candidates.push(parsed.install.registry);
    }
  }
  if (npmrcText !== null) {
    for (const raw of npmrcText.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
        continue;
      }
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (key !== "registry") continue;
      candidates.push(line.slice(eq + 1).trim());
    }
  }
  return chooseDefaultRegistry(candidates);
}

export function workspacePatterns(workspaces: unknown): string[] {
  const listed = Array.isArray(workspaces)
    ? workspaces
    : typeof workspaces === "object" &&
        workspaces !== null &&
        Array.isArray((workspaces as { packages?: unknown }).packages)
      ? (workspaces as { packages: unknown[] }).packages
      : [];
  return listed.filter(
    (item): item is string => typeof item === "string" && !item.startsWith("!"),
  );
}

/** Map a text `bun.lock` onto the package records `scan` receives. */
export function packagesFromLockfile(
  lockText: string,
  defaultRegistry = "",
): Bun.Security.Package[] {
  const lock = Bun.JSONC.parse(lockText) as {
    workspaces?: Record<string, LockMeta>;
    packages?: Record<string, unknown>;
    catalog?: Record<string, unknown>;
    catalogs?: Record<string, unknown>;
    overrides?: unknown;
    patchedDependencies?: Record<string, unknown>;
  };
  const ranges = new Map<string, string[]>();
  for (const workspace of Object.values(lock.workspaces ?? {})) {
    for (const field of RANGE_FIELDS) addRanges(ranges, workspace[field]);
  }
  const entries = Object.values(lock.packages ?? {});
  collectPins(ranges, lock);
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const meta = entry[2];
    if (typeof meta !== "object" || meta === null) continue;
    for (const field of RANGE_FIELDS) {
      addRanges(ranges, (meta as LockMeta)[field]);
    }
  }
  const packages: Bun.Security.Package[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const { name, version } = splitSpec(entry[0]);
    const resolution = typeof entry[1] === "string" ? entry[1] : "";
    const key = canonicalIncident(name) ?? name;
    const effective =
      key === "event-stream" && resolution.length === 0
        ? defaultRegistry
        : resolution;
    packages.push({
      name,
      version,
      requestedRange: requestedRangeFor(key, ranges.get(key) ?? []),
      tarball:
        key === "event-stream"
          ? eventStreamResolution(version, effective)
          : resolution.includes(".tgz")
            ? resolution
            : "",
    });
  }
  const seen = new Set<string>();
  for (const pkg of packages) {
    const incident = canonicalIncident(pkg.name);
    if (incident !== null) seen.add(incident);
  }
  packages.push(...unseenIncidentPackages(ranges, seen));
  return packages;
}

/** Incident pins from a package.json, including ones the lockfile has not recorded. */
export function packagesFromManifest(text: string): Bun.Security.Package[] {
  const manifest = JSON.parse(text) as LockMeta & PinSource;
  const ranges = new Map<string, string[]>();
  for (const field of RANGE_FIELDS) addRanges(ranges, manifest[field]);
  collectPins(ranges, manifest);
  return unseenIncidentPackages(ranges, new Set());
}

export interface CreateScannerOptions {
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly cwd?: string;
}

export function createScanner(
  options: CreateScannerOptions = {},
): Bun.Security.Scanner {
  return {
    version: "1",
    async scan({ packages }) {
      const env = options.env ?? Bun.env;
      const cwd = options.cwd ?? ".";
      const internalScopes = parseCsvEnv(env.BUN_SCANNER_INTERNAL_SCOPES);
      const trustedRegistries = parseCsvEnv(env.BUN_SCANNER_TRUSTED_REGISTRIES);
      const extendedOpts: ExtendedOfflineOptions = {
        ...(internalScopes === undefined ? {} : { internalScopes }),
        ...(trustedRegistries === undefined ? {} : { trustedRegistries }),
      };

      const advisories: Bun.Security.Advisory[] = [];
      const seen = new Set<string>();
      const pushAdvisory = (advisory: Bun.Security.Advisory): void => {
        const key = `${advisory.level}\n${canonicalPackageName(advisory.package)}\n${advisory.description ?? ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        advisories.push(advisory);
      };
      const push = (pkg: Bun.Security.Package): void => {
        const incidentAdvisory = advisoryFor(pkg);
        if (incidentAdvisory !== null) {
          pushAdvisory(incidentAdvisory);
        }
        for (const extra of checkExtendedOfflinePolicy(pkg, extendedOpts)) {
          pushAdvisory(extra);
        }
      };
      const resolvePath = (rel: string): string =>
        cwd === "." ? rel : path.join(cwd, rel);
      const pushFile = async (
        filename: string,
        read: (text: string) => Bun.Security.Package[],
      ): Promise<void> => {
        const file = Bun.file(resolvePath(filename));
        if (!(await file.exists())) return;
        try {
          for (const pkg of read(await file.text())) push(pkg);
        } catch {
          pushAdvisory({
            level: "fatal",
            package: filename,
            url: INCIDENT_URL,
            description: `${filename} could not be checked for the event-stream incident`,
          });
        }
      };
      for (const pkg of packages) push(pkg);
      let registry = "";
      try {
        const bunfig = Bun.file(resolvePath("bunfig.toml"));
        const npmrc = Bun.file(resolvePath(".npmrc"));
        registry = defaultRegistryFromProjectFiles(
          (await bunfig.exists()) ? await bunfig.text() : null,
          (await npmrc.exists()) ? await npmrc.text() : null,
        );
      } catch {
        pushAdvisory({
          level: "fatal",
          package: "bunfig.toml",
          url: INCIDENT_URL,
          description:
            "bunfig.toml could not be checked for the event-stream incident",
        });
      }
      const pushWorkspaceManifests = async (): Promise<void> => {
        const root = Bun.file(resolvePath("package.json"));
        if (!(await root.exists())) return;
        let patterns: string[] = [];
        try {
          const manifest = JSON.parse(await root.text()) as {
            workspaces?: unknown;
          };
          patterns = workspacePatterns(manifest.workspaces);
        } catch {
          return;
        }
        for (const pattern of patterns) {
          const glob = new Bun.Glob(
            pattern.endsWith("package.json")
              ? pattern
              : `${pattern.replace(/\/$/, "")}/package.json`,
          );
          for await (const rel of glob.scan({ cwd, onlyFiles: true })) {
            if (rel.split("/").includes("node_modules")) continue;
            await pushFile(rel, (text) => packagesFromManifest(text));
          }
        }
      };
      await pushFile("bun.lock", (text) =>
        packagesFromLockfile(text, registry),
      );
      await pushFile("package.json", (text) => packagesFromManifest(text));
      await pushWorkspaceManifests();

      // Layer 2: opt-in live OSV.dev batch CVE lookup + CVSS v3 + SQLite WAL TTL cache
      // (enabled via BUN_SCANNER_OSV=1 or BUN_SCANNER_OSV_ORIGIN)
      const fatalPackages = new Set(
        advisories
          .filter((a) => a.level === "fatal")
          .map((a) => canonicalPackageName(a.package)),
      );
      const remaining = packages.filter(
        (pkg) => !fatalPackages.has(canonicalPackageName(pkg.name)),
      );
      const osvAdvisories = await runOsvLayer(remaining, {
        env,
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
      });
      for (const advisory of osvAdvisories) pushAdvisory(advisory);

      return advisories;
    },
  };
}

export const scanner: Bun.Security.Scanner = createScanner();
