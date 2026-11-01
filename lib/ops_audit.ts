/**
 * @file lib/ops_audit.ts
 * @description Pure checks behind the release-tag registry and archive provenance gates.
 *
 * Both gates exist because the same two questions kept being answered by memory: "which docs tag is
 * deployable" and "where did this archive come from". The registry and the sidecars are the answer,
 * and these functions decide whether they still agree with the repository.
 */

export type ReleaseStatus = "current" | "superseded";

export interface ReleaseEntry {
  readonly status: ReleaseStatus;
  readonly deployable: boolean;
  readonly supersededBy?: string;
  readonly reason?: string;
  readonly commit?: string;
  readonly releasedAt?: string;
}

export interface Releases {
  readonly version: 1;
  readonly current: string;
  readonly tags: Readonly<Record<string, ReleaseEntry>>;
}

export interface ArchiveProvenance {
  readonly version: 1;
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly origin: string;
  readonly license: string;
  readonly recordedAt: string;
}

const PLACEHOLDER = new Set(["", "unknown", "tbd", "n/a", "none"]);

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.has(value.trim().toLowerCase());
}

/**
 * Chronological comparison for `docs-vYYYY.MM.DD` tags.
 *
 * Uses `Bun.semver.order` on the date portion rather than string sorting, so a tag like
 * `docs-v2026.9.1` cannot sort above `docs-v2026.10.31` by luck of the alphabet.
 */
export function compareReleaseTags(a: string, b: string): number {
  const strip = (tag: string): string => tag.replace(/^docs-v/, "");
  try {
    return Bun.semver.order(strip(a), strip(b));
  } catch {
    return strip(a).localeCompare(strip(b));
  }
}

export function parseReleases(raw: unknown): Releases {
  if (typeof raw !== "object" || raw === null)
    throw new Error("releases registry is not an object");
  const candidate = raw as Record<string, unknown>;
  if (candidate["version"] !== 1) {
    throw new Error(
      `unsupported releases version ${String(candidate["version"])}`,
    );
  }
  if (typeof candidate["current"] !== "string" || candidate["current"] === "") {
    throw new Error("releases registry is missing current");
  }
  const rawTags = candidate["tags"];
  if (typeof rawTags !== "object" || rawTags === null) {
    throw new Error("releases registry is missing tags");
  }

  const tags: Record<string, ReleaseEntry> = {};
  for (const [tag, value] of Object.entries(
    rawTags as Record<string, unknown>,
  )) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`releases entry ${tag} is not an object`);
    }
    const entry = value as Record<string, unknown>;
    const status = entry["status"];
    if (status !== "current" && status !== "superseded") {
      throw new Error(`releases entry ${tag} has status ${String(status)}`);
    }
    if (typeof entry["deployable"] !== "boolean") {
      throw new Error(`releases entry ${tag} is missing deployable`);
    }
    const optional = (key: string): string | undefined =>
      typeof entry[key] === "string" ? (entry[key] as string) : undefined;
    const supersededBy = optional("supersededBy");
    const reason = optional("reason");
    const commit = optional("commit");
    const releasedAt = optional("releasedAt");
    tags[tag] = {
      status,
      deployable: entry["deployable"],
      ...(supersededBy === undefined ? {} : { supersededBy }),
      ...(reason === undefined ? {} : { reason }),
      ...(commit === undefined ? {} : { commit }),
      ...(releasedAt === undefined ? {} : { releasedAt }),
    };
  }
  return { version: 1, current: candidate["current"], tags };
}

/**
 * Compare a registry against the tags that actually exist.
 *
 * The registry is not allowed to be a wish: a tag with no entry means the next deploy cannot tell
 * whether it is current, and an entry with no tag means the record describes something that is gone.
 */
export function auditReleases(
  tagNames: readonly string[],
  registry: Releases,
): string[] {
  const errors: string[] = [];
  const present = new Set(tagNames);
  const currentEntries = Object.entries(registry.tags).filter(
    ([, entry]) => entry.status === "current",
  );

  if (currentEntries.length !== 1) {
    errors.push(
      `registry must mark exactly one tag current, found ${currentEntries.length}`,
    );
  }
  for (const [tag, entry] of currentEntries) {
    if (tag !== registry.current) {
      errors.push(
        `${tag} is marked current but registry.current is ${registry.current}`,
      );
    }
    if (!entry.deployable) errors.push(`${tag} is current but not deployable`);
  }

  for (const tag of tagNames) {
    if (!(tag in registry.tags)) errors.push(`${tag} has no registry entry`);
  }
  for (const tag of Object.keys(registry.tags)) {
    if (!present.has(tag))
      errors.push(`${tag} is registered but no such tag exists`);
  }

  for (const [tag, entry] of Object.entries(registry.tags)) {
    if (entry.status !== "superseded") continue;
    if (entry.deployable)
      errors.push(`${tag} is superseded but still deployable`);
    if (entry.supersededBy === undefined || isPlaceholder(entry.supersededBy)) {
      errors.push(`${tag} is superseded but names no replacement`);
    } else if (!(entry.supersededBy in registry.tags)) {
      errors.push(
        `${tag} is superseded by ${entry.supersededBy}, which is not registered`,
      );
    }
    if (entry.reason === undefined || isPlaceholder(entry.reason)) {
      errors.push(`${tag} is superseded but records no reason`);
    }
  }

  // Tags are `docs-vYYYY.MM.DD`, so lexicographic order after the prefix is chronological.
  const newest = [...tagNames].sort().at(-1);
  if (newest !== undefined && registry.current !== newest) {
    errors.push(
      `registry.current is ${registry.current}; the newest tag is ${newest}`,
    );
  }

  return errors;
}

export function parseProvenance(raw: unknown): ArchiveProvenance {
  if (typeof raw !== "object" || raw === null)
    throw new Error("provenance is not an object");
  const candidate = raw as Record<string, unknown>;
  if (candidate["version"] !== 1) {
    throw new Error(
      `unsupported provenance version ${String(candidate["version"])}`,
    );
  }
  const text = (key: string): string => {
    const value = candidate[key];
    if (typeof value !== "string" || value === "")
      throw new Error(`provenance is missing ${key}`);
    return value;
  };
  const bytes = candidate["bytes"];
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
    throw new Error("provenance is missing bytes");
  }
  return {
    version: 1,
    file: text("file"),
    sha256: text("sha256"),
    bytes,
    origin: text("origin"),
    license: text("license"),
    recordedAt: text("recordedAt"),
  };
}

export interface ArchiveFact {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Every tracked archive must have a sidecar whose checksum matches the file it describes.
 *
 * `origin` and `license` are rejected when they are placeholders: "unknown" is a note to self, not
 * provenance, and a sidecar that says it is worse than no sidecar because it looks audited.
 */
export function auditArchives(
  archives: readonly ArchiveFact[],
  sidecars: ReadonlyMap<string, ArchiveProvenance | Error>,
): string[] {
  const errors: string[] = [];
  for (const archive of archives) {
    const sidecar = sidecars.get(archive.file);
    if (sidecar === undefined) {
      errors.push(`${archive.file}: no provenance/${archive.file}.json`);
      continue;
    }
    if (sidecar instanceof Error) {
      errors.push(`${archive.file}: ${sidecar.message}`);
      continue;
    }
    if (sidecar.file !== archive.file) {
      errors.push(`${archive.file}: sidecar names ${sidecar.file}`);
    }
    if (sidecar.sha256 !== archive.sha256) {
      errors.push(`${archive.file}: sidecar sha256 does not match`);
    }
    if (sidecar.bytes !== archive.bytes) {
      errors.push(
        `${archive.file}: sidecar bytes ${sidecar.bytes} != ${archive.bytes}`,
      );
    }
    if (isPlaceholder(sidecar.origin)) {
      errors.push(`${archive.file}: origin is not provenance`);
    }
    if (isPlaceholder(sidecar.license)) {
      errors.push(`${archive.file}: license is not provenance`);
    }
  }
  return errors;
}
