/**
 * @file install_security_layers.ts
 * @description Extended supply-chain hardening layers for `scripts/install_security_scanner.ts`:
 *
 * 1. Expanded compromised-package denylist (`ua-parser-js`, `coa`, `rc`, `node-ipc`,
 *    `peacenotwar`, `colors`, `faker`, `eslint-scope`, `polyfill-io`) with Unicode NFKC /
 *    invisible-character folding and tarball/range provenance verification.
 * 2. Internal-scope dependency confusion defense (`@sportsdesk-ops/*` blocked from public
 *    registries; configurable via `BUN_SCANNER_INTERNAL_SCOPES`).
 * 3. Transport & pinning hygiene (blocks plaintext remote HTTP tarballs; warns on unpinned git).
 * 4. FIRST.org CVSS v3.0/v3.1 Base Score calculator (`parseCvssV3BaseScore`, `scoreToSeverity`).
 * 5. Local `bun:sqlite` WAL TTL cache (`openScannerCache`, default `scratch/.osv-scanner-cache.sqlite`).
 * 6. Live OSV.dev batch vulnerability lookup (`queryOsvBatch`) with stale-cache outage fallback
 *    and strict CI mode (`BUN_SCANNER_FAIL_CLOSED=1`).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCANNER_DOCS_URL = "https://bun.com/docs/pm/security-scanner-api";
const DEP_CONFUSION_URL =
  "https://medium.com/@alex.birsan/dependency-confusion-4a5d60fec610";

export interface ExtendedDenylistRule {
  readonly name: string;
  readonly range: string;
  readonly level: "fatal" | "warn";
  readonly url: string;
  readonly description: string;
}

export const EXTENDED_DENYLIST: readonly ExtendedDenylistRule[] = [
  {
    name: "ua-parser-js",
    range: "0.7.29 || 0.8.0 || 1.0.0",
    level: "fatal",
    url: "https://github.com/advisories/GHSA-pjwm-rvh2-c87w",
    description:
      "ua-parser-js 0.7.29/0.8.0/1.0.0 contained credential-stealing malware",
  },
  {
    name: "coa",
    range: "2.0.3 || 2.0.4 || 2.1.1 || 2.1.3 || 3.0.1 || 3.1.3",
    level: "fatal",
    url: "https://github.com/advisories/GHSA-73qr-pfmq-6rp8",
    description:
      "coa compromised releases contained credential-stealing malware",
  },
  {
    name: "rc",
    range: "1.2.9 || 1.3.9 || 2.3.9",
    level: "fatal",
    url: "https://github.com/advisories/GHSA-g2q5-5433-rhrf",
    description:
      "rc compromised releases contained credential-stealing malware",
  },
  {
    name: "node-ipc",
    range: ">=10.1.1 <=10.1.3 || >=11.0.0 <12.0.0",
    level: "fatal",
    url: "https://github.com/advisories/GHSA-97m3-w2cp-4xx6",
    description:
      "node-ipc 10.1.1–10.1.3 and 11.x shipped destructive protestware",
  },
  {
    name: "peacenotwar",
    range: "*",
    level: "fatal",
    url: "https://github.com/advisories/GHSA-97m3-w2cp-4xx6",
    description: "peacenotwar is the node-ipc protestware payload package",
  },
  {
    name: "colors",
    range: "1.4.1 || 1.4.2 || 1.4.44-liberty-2",
    level: "fatal",
    url: "https://snyk.io/blog/open-source-npm-packages-colors-faker/",
    description:
      "colors 1.4.1/1.4.2/1.4.44-liberty-2 contain intentional infinite-loop sabotage",
  },
  {
    name: "faker",
    range: "6.6.6",
    level: "fatal",
    url: "https://snyk.io/blog/open-source-npm-packages-colors-faker/",
    description: "faker 6.6.6 is a sabotaged release",
  },
  {
    name: "eslint-scope",
    range: "3.7.2",
    level: "fatal",
    url: "https://eslint.org/blog/2018/07/postmortem-for-malicious-package-publishes/",
    description: "eslint-scope 3.7.2 exfiltrated npm credentials on install",
  },
  {
    name: "polyfill-io",
    range: "*",
    level: "fatal",
    url: "https://sansec.io/research/polyfill-supply-chain-attack",
    description:
      "polyfill-io is associated with a compromised CDN supply-chain attack",
  },
];

const DENYLIST_BY_NAME: ReadonlyMap<string, readonly ExtendedDenylistRule[]> =
  (() => {
    const map = new Map<string, ExtendedDenylistRule[]>();
    for (const rule of EXTENDED_DENYLIST) {
      const key = rule.name.toLowerCase();
      const list = map.get(key);
      if (list === undefined) map.set(key, [rule]);
      else list.push(rule);
    }
    return map;
  })();

const SEMVER_EXACT =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PUBLIC_REGISTRIES = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
]);
const DEFAULT_INTERNAL_SCOPES: readonly string[] = ["@sportsdesk-ops"];
const DEFAULT_TRUSTED_REGISTRIES: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
];
const NON_REGISTRY_RANGE_PREFIXES = [
  "file:",
  "link:",
  "github:",
  "git+",
  "git://",
  "http://",
  "https://",
  "npm:",
  "patch:",
];

const OSV_DEFAULT_ORIGIN = "https://api.osv.dev";
const OSV_DEFAULT_TIMEOUT_MS = 5000;
const OSV_BATCH_SIZE = 500;
const OSV_DETAIL_CONCURRENCY = 10;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_OSV_CACHE_PATH = path.join(
  import.meta.dir,
  "..",
  "scratch",
  ".osv-scanner-cache.sqlite",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize package names with Unicode NFKC and strip invisible format/whitespace characters. */
export function canonicalPackageName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[\p{Cf}\s]/gu, "")
    .toLowerCase();
}

function semverCore(version: string): string | null {
  const match = SEMVER_EXACT.exec(version);
  if (match === null) return null;
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  return `${major}.${minor}.${patch}`;
}

function matchesDenylistRange(version: string, range: string): boolean {
  if (range === "*") return true;
  if (!SEMVER_EXACT.test(version)) return true;
  for (const part of range.split("||")) {
    if (part.trim() === version) return true;
  }
  const core = semverCore(version);
  if (core === null) return true;
  try {
    return (
      Bun.semver.satisfies(version, range) || Bun.semver.satisfies(core, range)
    );
  } catch {
    return true;
  }
}

function expectedTarballFilename(name: string, version: string): string {
  const slashIdx = name.lastIndexOf("/");
  const baseName = slashIdx >= 0 ? name.slice(slashIdx + 1) : name;
  return `${baseName}-${version}.tgz`;
}

function normalizeScope(scope: string): string | null {
  const trimmed = canonicalPackageName(scope).replace(/\/+$/, "");
  if (trimmed === "") return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function isPlaintextRemoteTarball(tarball: string): boolean {
  if (!tarball.toLowerCase().startsWith("http://")) return false;
  try {
    const url = new URL(tarball);
    return !LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return true;
  }
}

function isUnpinnedGitSpecifier(version: string): boolean {
  const lower = version.toLowerCase();
  if (
    lower.startsWith("github:") ||
    lower.startsWith("git+") ||
    lower.startsWith("git://")
  ) {
    return !version.includes("#");
  }
  return false;
}

export interface ExtendedOfflineOptions {
  readonly internalScopes?: readonly string[];
  readonly trustedRegistries?: readonly string[];
}

export function checkExtendedOfflinePolicy(
  pkg: Bun.Security.Package,
  options: ExtendedOfflineOptions = {},
): Bun.Security.Advisory[] {
  const advisories: Bun.Security.Advisory[] = [];
  const canonical = canonicalPackageName(pkg.name);

  // 1. Internal-scope dependency confusion defense
  const scopes = (options.internalScopes ?? DEFAULT_INTERNAL_SCOPES)
    .map(normalizeScope)
    .filter((s): s is string => s !== null);
  if (pkg.tarball !== "" && scopes.length > 0) {
    const matchedScope = scopes.find((scope) =>
      canonical.startsWith(`${scope}/`),
    );
    if (matchedScope !== undefined) {
      try {
        const host = new URL(pkg.tarball).hostname.toLowerCase();
        if (PUBLIC_REGISTRIES.has(host)) {
          advisories.push({
            level: "fatal",
            package: pkg.name,
            url: DEP_CONFUSION_URL,
            description: `internal scope ${matchedScope} resolved from public registry (${host}); possible dependency confusion attack`,
          });
        }
      } catch {
        // Malformed tarball URL checked below if HTTP
      }
    }
  }

  // 2. Expanded denylist + provenance verification
  const rules = DENYLIST_BY_NAME.get(canonical);
  if (rules !== undefined) {
    let matchedAny = false;
    for (const rule of rules) {
      if (matchesDenylistRange(pkg.version, rule.range)) {
        matchedAny = true;
        const isNonSemver =
          rule.range !== "*" && !SEMVER_EXACT.test(pkg.version);
        advisories.push({
          level: rule.level,
          package: pkg.name,
          url: rule.url,
          description: isNonSemver
            ? `${pkg.name}@${pkg.version} is not a registry semver and cannot be cleared against denylist range ${rule.range}: ${rule.description}`
            : rule.description,
        });
      }
    }

    if (!matchedAny) {
      const trustedRegistries = new Set(
        (options.trustedRegistries ?? DEFAULT_TRUSTED_REGISTRIES)
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h !== ""),
      );
      const rangeLower = pkg.requestedRange.trim().toLowerCase();
      for (const prefix of NON_REGISTRY_RANGE_PREFIXES) {
        if (rangeLower.startsWith(prefix)) {
          advisories.push({
            level: "fatal",
            package: pkg.name,
            url: rules[0]?.url ?? SCANNER_DOCS_URL,
            description: `denylisted package name ${pkg.name}@${pkg.version} resolved via non-registry specifier (${pkg.requestedRange})`,
          });
          break;
        }
      }
      if (pkg.tarball !== "") {
        let url: URL | null = null;
        try {
          url = new URL(pkg.tarball);
        } catch {
          advisories.push({
            level: "fatal",
            package: pkg.name,
            url: rules[0]?.url ?? SCANNER_DOCS_URL,
            description: `denylisted package name ${pkg.name}@${pkg.version} has malformed tarball URL (${pkg.tarball})`,
          });
        }
        if (url !== null) {
          const host = url.hostname.toLowerCase();
          if (!trustedRegistries.has(host)) {
            advisories.push({
              level: "fatal",
              package: pkg.name,
              url: rules[0]?.url ?? SCANNER_DOCS_URL,
              description: `denylisted package name ${pkg.name}@${pkg.version} resolved from untrusted tarball host (${host})`,
            });
          }
          const filename = url.pathname.slice(
            url.pathname.lastIndexOf("/") + 1,
          );
          const expected = expectedTarballFilename(pkg.name, pkg.version);
          if (filename !== expected) {
            advisories.push({
              level: "fatal",
              package: pkg.name,
              url: rules[0]?.url ?? SCANNER_DOCS_URL,
              description: `denylisted package tarball filename (${filename}) does not match declared ${pkg.name}@${pkg.version} (expected ${expected})`,
            });
          }
        }
      }
    }
  }

  // 3. Transport & git pinning checks
  if (pkg.tarball !== "" && isPlaintextRemoteTarball(pkg.tarball)) {
    advisories.push({
      level: "fatal",
      package: pkg.name,
      url: SCANNER_DOCS_URL,
      description: `plaintext HTTP tarball (${pkg.tarball}) is vulnerable to MITM tampering`,
    });
  }
  if (isUnpinnedGitSpecifier(pkg.version)) {
    advisories.push({
      level: "warn",
      package: pkg.name,
      url: SCANNER_DOCS_URL,
      description: `unpinned git/GitHub dependency (${pkg.version}) should pin a commit SHA or tag with #<ref>`,
    });
  }

  return advisories;
}

// ============================================================================
// FIRST.org CVSS v3.0 / v3.1 Base Score calculator
// ============================================================================

export type CvssSeverity = "NONE" | "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

const AV_WEIGHT: Record<string, number> = {
  N: 0.85,
  A: 0.62,
  L: 0.55,
  P: 0.2,
};
const AC_WEIGHT: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_UNCHANGED_WEIGHT: Record<string, number> = {
  N: 0.85,
  L: 0.62,
  H: 0.27,
};
const PR_CHANGED_WEIGHT: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI_WEIGHT: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA_WEIGHT: Record<string, number> = { N: 0, L: 0.22, H: 0.56 };

function roundupCvss(value: number): number {
  const intInput = Math.round(value * 100000);
  if (intInput % 10000 === 0) return intInput / 100000;
  return (Math.floor(intInput / 10000) + 1) / 10;
}

export function parseCvssV3BaseScore(vector: string): number | null {
  const trimmed = vector.trim();
  if (!trimmed.startsWith("CVSS:3.0/") && !trimmed.startsWith("CVSS:3.1/")) {
    return null;
  }
  const metrics = new Map<string, string>();
  for (const part of trimmed.split("/").slice(1)) {
    const colon = part.indexOf(":");
    if (colon <= 0) return null;
    metrics.set(part.slice(0, colon), part.slice(colon + 1));
  }
  const scope = metrics.get("S");
  if (scope !== "U" && scope !== "C") return null;

  const av = AV_WEIGHT[metrics.get("AV") ?? ""];
  const ac = AC_WEIGHT[metrics.get("AC") ?? ""];
  const pr = (scope === "C" ? PR_CHANGED_WEIGHT : PR_UNCHANGED_WEIGHT)[
    metrics.get("PR") ?? ""
  ];
  const ui = UI_WEIGHT[metrics.get("UI") ?? ""];
  const c = CIA_WEIGHT[metrics.get("C") ?? ""];
  const i = CIA_WEIGHT[metrics.get("I") ?? ""];
  const a = CIA_WEIGHT[metrics.get("A") ?? ""];

  if (
    av === undefined ||
    ac === undefined ||
    pr === undefined ||
    ui === undefined ||
    c === undefined ||
    i === undefined ||
    a === undefined
  ) {
    return null;
  }

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact =
    scope === "U"
      ? 6.42 * iss
      : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  if (impact <= 0) return 0;

  const exploitability = 8.22 * av * ac * pr * ui;
  const raw =
    scope === "U"
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);
  return roundupCvss(raw);
}

export function scoreToSeverity(score: number): CvssSeverity {
  if (score >= 9.0) return "CRITICAL";
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MODERATE";
  if (score > 0) return "LOW";
  return "NONE";
}

// ============================================================================
// Local bun:sqlite WAL TTL cache
// ============================================================================

export interface CachedVulnDetail {
  readonly id: string;
  readonly summary: string;
  readonly severity: string | null;
  readonly score: number | null;
}

export interface ScannerCache {
  getPackageVulns(pkgKey: string, ttlMs: number, now?: number): string[] | null;
  getPackageVulnsStale(pkgKey: string): string[] | null;
  setPackageVulns(
    pkgKey: string,
    vulnIds: readonly string[],
    now?: number,
  ): void;
  getVulnDetail(
    id: string,
    ttlMs: number,
    now?: number,
  ): CachedVulnDetail | null;
  getVulnDetailStale(id: string): CachedVulnDetail | null;
  setVulnDetail(detail: CachedVulnDetail, now?: number): void;
  close(): void;
}

interface PkgVulnsRow {
  vuln_ids_json: string;
  fetched_at: number;
}

interface VulnDetailRow {
  vuln_id: string;
  summary: string;
  severity: string | null;
  score: number | null;
  fetched_at: number;
}

function parseVulnIds(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((item): item is string => typeof item === "string")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function openScannerCache(dbPath: string): ScannerCache | null {
  let db: Database;
  try {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    db = new Database(dbPath, { create: true });
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS pkg_vulns (
        pkg_key TEXT PRIMARY KEY,
        vuln_ids_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vuln_details (
        vuln_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        severity TEXT,
        score REAL,
        fetched_at INTEGER NOT NULL
      );
    `);
  } catch {
    return null;
  }

  const selectPkg = db.query<PkgVulnsRow, [string]>(
    "SELECT vuln_ids_json, fetched_at FROM pkg_vulns WHERE pkg_key = ?1",
  );
  const upsertPkg = db.query<null, [string, string, number]>(
    `INSERT INTO pkg_vulns (pkg_key, vuln_ids_json, fetched_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(pkg_key) DO UPDATE SET
       vuln_ids_json = excluded.vuln_ids_json,
       fetched_at = excluded.fetched_at`,
  );
  const selectDetail = db.query<VulnDetailRow, [string]>(
    "SELECT vuln_id, summary, severity, score, fetched_at FROM vuln_details WHERE vuln_id = ?1",
  );
  const upsertDetail = db.query<
    null,
    [string, string, string | null, number | null, number]
  >(
    `INSERT INTO vuln_details (vuln_id, summary, severity, score, fetched_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(vuln_id) DO UPDATE SET
       summary = excluded.summary,
       severity = excluded.severity,
       score = excluded.score,
       fetched_at = excluded.fetched_at`,
  );

  return {
    getPackageVulns(pkgKey, ttlMs, now = Date.now()) {
      try {
        const row = selectPkg.get(pkgKey);
        if (!row || now - row.fetched_at > ttlMs) return null;
        return parseVulnIds(row.vuln_ids_json);
      } catch {
        return null;
      }
    },
    getPackageVulnsStale(pkgKey) {
      try {
        const row = selectPkg.get(pkgKey);
        return row ? parseVulnIds(row.vuln_ids_json) : null;
      } catch {
        return null;
      }
    },
    setPackageVulns(pkgKey, vulnIds, now = Date.now()) {
      try {
        upsertPkg.run(pkgKey, JSON.stringify(vulnIds), now);
      } catch {
        // Ignore transient write errors
      }
    },
    getVulnDetail(id, ttlMs, now = Date.now()) {
      try {
        const row = selectDetail.get(id);
        if (!row || now - row.fetched_at > ttlMs) return null;
        return {
          id: row.vuln_id,
          summary: row.summary,
          severity: row.severity,
          score: row.score,
        };
      } catch {
        return null;
      }
    },
    getVulnDetailStale(id) {
      try {
        const row = selectDetail.get(id);
        if (!row) return null;
        return {
          id: row.vuln_id,
          summary: row.summary,
          severity: row.severity,
          score: row.score,
        };
      } catch {
        return null;
      }
    },
    setVulnDetail(detail, now = Date.now()) {
      try {
        upsertDetail.run(
          detail.id,
          detail.summary,
          detail.severity,
          detail.score,
          now,
        );
      } catch {
        // Ignore transient write errors
      }
    },
    close() {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    },
  };
}

// ============================================================================
// Live OSV.dev batch vulnerability lookup
// ============================================================================

export interface OsvQueryOptions {
  readonly origin?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly cache?: ScannerCache | null;
  readonly cacheTtlMs?: number;
}

interface OsvVulnDetail {
  readonly id: string;
  readonly summary: string | null;
  readonly severity: string | null;
  readonly score: number | null;
}

function pkgCacheKey(pkg: Bun.Security.Package): string {
  return `npm:${pkg.name}@${pkg.version}`;
}

function extractSeverityAndScore(detail: Record<string, unknown>): {
  readonly severity: string | null;
  readonly score: number | null;
} {
  let maxScore: number | null = null;
  if (Array.isArray(detail.severity)) {
    for (const entry of detail.severity) {
      if (!isRecord(entry) || typeof entry.score !== "string") continue;
      if (entry.type === "CVSS_V3" || entry.score.startsWith("CVSS:3.")) {
        const parsed = parseCvssV3BaseScore(entry.score);
        if (parsed !== null && (maxScore === null || parsed > maxScore)) {
          maxScore = parsed;
        }
      }
    }
  }
  const dbSpecific = detail.database_specific;
  if (isRecord(dbSpecific) && typeof dbSpecific.severity === "string") {
    const raw = dbSpecific.severity.trim().toUpperCase();
    if (raw !== "") {
      return { severity: raw === "MEDIUM" ? "MODERATE" : raw, score: maxScore };
    }
  }
  if (maxScore !== null) {
    return { severity: scoreToSeverity(maxScore), score: maxScore };
  }
  return { severity: null, score: null };
}

function formatOsvAdvisory(
  pkg: Bun.Security.Package,
  id: string,
  detail: OsvVulnDetail | undefined,
): Bun.Security.Advisory {
  const severity = detail?.severity ?? null;
  const score = detail?.score ?? null;
  const summary = detail?.summary ?? null;

  let label = id;
  if (severity !== null && score !== null) {
    label = `${id} (${severity} ${score.toFixed(1)})`;
  } else if (severity !== null) {
    label = `${id} (${severity})`;
  } else if (score !== null) {
    label = `${id} (CVSS ${score.toFixed(1)})`;
  }

  const level: "fatal" | "warn" =
    id.startsWith("MAL-") ||
    severity === "CRITICAL" ||
    severity === "HIGH" ||
    (score !== null && score >= 7.0)
      ? "fatal"
      : "warn";

  return {
    level,
    package: pkg.name,
    url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
    description:
      summary !== null
        ? `${label}: ${summary}`
        : `${label} affects ${pkg.name}@${pkg.version}`,
  };
}

async function fetchVulnDetails(
  ids: readonly string[],
  origin: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  cache: ScannerCache | null,
  cacheTtlMs: number,
): Promise<Map<string, OsvVulnDetail>> {
  const details = new Map<string, OsvVulnDetail>();
  const toFetch: string[] = [];

  for (const id of ids) {
    const cached = cache?.getVulnDetail(id, cacheTtlMs) ?? null;
    if (cached !== null) {
      details.set(id, {
        id: cached.id,
        summary: cached.summary === "" ? null : cached.summary,
        severity: cached.severity,
        score: cached.score,
      });
    } else {
      toFetch.push(id);
    }
  }

  for (
    let offset = 0;
    offset < toFetch.length;
    offset += OSV_DETAIL_CONCURRENCY
  ) {
    const slice = toFetch.slice(offset, offset + OSV_DETAIL_CONCURRENCY);
    await Promise.all(
      slice.map(async (id) => {
        try {
          const response = await fetchImpl(
            `${origin}/v1/vulns/${encodeURIComponent(id)}`,
            {
              method: "GET",
              headers: { accept: "application/json" },
              signal: AbortSignal.timeout(timeoutMs),
            },
          );
          if (!response.ok) return;
          const body: unknown = await response.json();
          if (!isRecord(body)) return;
          const summary =
            typeof body.summary === "string" && body.summary.trim() !== ""
              ? body.summary.trim()
              : null;
          const { severity, score } = extractSeverityAndScore(body);
          details.set(id, { id, summary, severity, score });
          cache?.setVulnDetail({
            id,
            summary: summary ?? "",
            severity,
            score,
          });
        } catch {
          const stale = cache?.getVulnDetailStale(id) ?? null;
          if (stale !== null) {
            details.set(id, {
              id: stale.id,
              summary: stale.summary === "" ? null : stale.summary,
              severity: stale.severity,
              score: stale.score,
            });
          }
        }
      }),
    );
  }
  return details;
}

export async function queryOsvBatch(
  packages: readonly Bun.Security.Package[],
  options: OsvQueryOptions = {},
): Promise<Bun.Security.Advisory[]> {
  const registryPackages = packages.filter((pkg) =>
    SEMVER_EXACT.test(pkg.version),
  );
  if (registryPackages.length === 0) return [];

  const origin = (options.origin ?? OSV_DEFAULT_ORIGIN).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? OSV_DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = options.cache ?? null;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  const matched: Array<{
    readonly pkg: Bun.Security.Package;
    readonly id: string;
  }> = [];
  const uniqueIds = new Set<string>();
  const uncached: Bun.Security.Package[] = [];

  for (const pkg of registryPackages) {
    const cachedIds =
      cache?.getPackageVulns(pkgCacheKey(pkg), cacheTtlMs) ?? null;
    if (cachedIds !== null) {
      for (const id of cachedIds) {
        matched.push({ pkg, id });
        uniqueIds.add(id);
      }
    } else {
      uncached.push(pkg);
    }
  }

  for (let offset = 0; offset < uncached.length; offset += OSV_BATCH_SIZE) {
    const chunk = uncached.slice(offset, offset + OSV_BATCH_SIZE);
    const response = await fetchImpl(`${origin}/v1/querybatch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        queries: chunk.map((pkg) => ({
          package: { name: pkg.name, ecosystem: "npm" },
          version: pkg.version,
        })),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`OSV querybatch HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    const results =
      isRecord(body) && Array.isArray(body.results) ? body.results : [];
    for (let index = 0; index < chunk.length; index += 1) {
      const pkg = chunk[index];
      if (pkg === undefined) continue;
      const entry = results[index];
      const pkgVulnIds: string[] = [];
      if (isRecord(entry) && Array.isArray(entry.vulns)) {
        for (const vuln of entry.vulns) {
          if (
            !isRecord(vuln) ||
            typeof vuln.id !== "string" ||
            vuln.id.trim() === ""
          ) {
            continue;
          }
          pkgVulnIds.push(vuln.id);
          matched.push({ pkg, id: vuln.id });
          uniqueIds.add(vuln.id);
        }
      }
      cache?.setPackageVulns(pkgCacheKey(pkg), pkgVulnIds);
    }
  }

  if (matched.length === 0) return [];
  const details = await fetchVulnDetails(
    [...uniqueIds],
    origin,
    timeoutMs,
    fetchImpl,
    cache,
    cacheTtlMs,
  );
  return matched.map(({ pkg, id }) =>
    formatOsvAdvisory(pkg, id, details.get(id)),
  );
}

export interface RunOsvLayerOptions {
  readonly env: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
}

export async function runOsvLayer(
  packages: readonly Bun.Security.Package[],
  options: RunOsvLayerOptions,
): Promise<Bun.Security.Advisory[]> {
  const { env } = options;
  const osvEnabled =
    env.BUN_SCANNER_OFFLINE !== "1" &&
    (env.BUN_SCANNER_OSV === "1" ||
      (typeof env.BUN_SCANNER_OSV_ORIGIN === "string" &&
        env.BUN_SCANNER_OSV_ORIGIN.trim() !== ""));

  if (!osvEnabled || packages.length === 0) return [];

  const parsedTimeout = Number(env.BUN_SCANNER_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? Math.trunc(parsedTimeout)
      : OSV_DEFAULT_TIMEOUT_MS;

  const parsedTtl = Number(env.BUN_SCANNER_CACHE_TTL_MS);
  const cacheTtlMs =
    Number.isFinite(parsedTtl) && parsedTtl > 0
      ? Math.trunc(parsedTtl)
      : DEFAULT_CACHE_TTL_MS;

  const failClosed = env.BUN_SCANNER_FAIL_CLOSED === "1";
  const cache =
    env.BUN_SCANNER_NO_CACHE === "1"
      ? null
      : openScannerCache(
          env.BUN_SCANNER_CACHE_PATH?.trim() || DEFAULT_OSV_CACHE_PATH,
        );

  try {
    return await queryOsvBatch(packages, {
      ...(env.BUN_SCANNER_OSV_ORIGIN === undefined
        ? {}
        : { origin: env.BUN_SCANNER_OSV_ORIGIN }),
      timeoutMs,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
      cache,
      cacheTtlMs,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const target = packages[0]?.name ?? "osv-scanner";
    if (!failClosed && cache !== null) {
      const registryPackages = packages.filter((pkg) =>
        SEMVER_EXACT.test(pkg.version),
      );
      let allCached = registryPackages.length > 0;
      const staleAdvisories: Bun.Security.Advisory[] = [];
      for (const pkg of registryPackages) {
        const staleIds = cache.getPackageVulnsStale(pkgCacheKey(pkg));
        if (staleIds === null) {
          allCached = false;
          break;
        }
        for (const id of staleIds) {
          const staleDetail = cache.getVulnDetailStale(id);
          staleAdvisories.push(
            formatOsvAdvisory(
              pkg,
              id,
              staleDetail === null
                ? undefined
                : {
                    id: staleDetail.id,
                    summary:
                      staleDetail.summary === "" ? null : staleDetail.summary,
                    severity: staleDetail.severity,
                    score: staleDetail.score,
                  },
            ),
          );
        }
      }
      if (allCached) {
        staleAdvisories.push({
          level: "warn",
          package: target,
          url: "https://osv.dev/",
          description: `OSV lookup unavailable (${reason}); served stale SQLite cache. Set BUN_SCANNER_OFFLINE=1 to silence offline warnings.`,
        });
        return staleAdvisories;
      }
    }

    return [
      {
        level: failClosed ? "fatal" : "warn",
        package: target,
        url: "https://osv.dev/",
        description: failClosed
          ? `OSV lookup unavailable (${reason}) and BUN_SCANNER_FAIL_CLOSED=1 is set`
          : `OSV lookup unavailable (${reason}); offline denylist still ran. Set BUN_SCANNER_OFFLINE=1 to silence offline warnings.`,
      },
    ];
  } finally {
    cache?.close();
  }
}

export function parseCsvEnv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}
