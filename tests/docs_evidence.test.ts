/**
 * Evidence ledger ↔ OpenAPI spec parity.
 *
 * The ledger is the source of truth for evidence tiers; the spec must not
 * outrun it. These tests prove the machine-readable ledger and the generated
 * spec agree (row cover, tier, capture honesty, declared counts) and that the
 * human docs mention every surface the ledger claims, so no fabricated or
 * unlabelled operation can slip into the release.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkLedger,
  collectOperations,
  CODES,
  findOperationCoverage,
  isRecord,
  LEDGER_TIERS,
  type CheckOutcome,
  type Operation,
} from "../scripts/verify_docs.ts";

const ROOT = join(import.meta.dir, "..");
const SPEC_PATH = join(ROOT, "docs", "openapi.json");
const LEDGER_PATH = join(ROOT, "docs", "evidence", "ledger.json");
const EVIDENCE_MD_PATH = join(ROOT, "docs", "EVIDENCE.md");
const GS_CONTRACTS_PATH = join(ROOT, "docs", "gs-manager-contracts.md");

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function loadJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readText(path));
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function loadLedger(): Record<string, unknown> {
  if (!existsSync(LEDGER_PATH)) {
    throw new Error(
      "docs/evidence/ledger.json missing — the evidence ledger is the P1 deliverable",
    );
  }
  return loadJsonObject(LEDGER_PATH);
}

function loadSpec(): Record<string, unknown> {
  return loadJsonObject(SPEC_PATH);
}

function operationsOf(spec: Record<string, unknown>): Operation[] {
  return collectOperations(spec);
}

function expectNoIssues(outcome: CheckOutcome): void {
  if (outcome.issues.length > 0 || outcome.status === "fail") {
    const rendered = outcome.issues
      .map((issue) => `  [${issue.code}] ${issue.message}`)
      .join("\n");
    throw new Error(`${outcome.name} failed:\n${rendered}`);
  }
  expect(outcome.status).toBe("pass");
}

function ledgerRows(
  ledger: Record<string, unknown>,
): Record<string, unknown>[] {
  const rows = ledger.operations;
  if (!Array.isArray(rows)) {
    throw new Error("ledger.operations must be an array");
  }
  return rows.filter(isRecord);
}

function rowKey(row: Record<string, unknown>): string {
  return `${String(row.method).toUpperCase()} ${String(row.path)}`;
}

function declaredTierCounts(counts: unknown): Map<string, number> | undefined {
  if (!isRecord(counts)) return undefined;
  const candidates = [counts, counts.byTier, counts.tiers, counts.tierCounts];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const numbers = new Map<string, number>();
    for (const tier of LEDGER_TIERS) {
      const value = candidate[tier];
      if (typeof value === "number") numbers.set(tier, value);
    }
    if (numbers.size > 0) return numbers;
  }
  return undefined;
}

function bumpDeclaredCount(ledger: Record<string, unknown>): boolean {
  const counts = ledger.counts;
  if (!isRecord(counts)) return false;
  const candidates = [counts, counts.byTier, counts.tiers, counts.tierCounts];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    for (const tier of LEDGER_TIERS) {
      const value = candidate[tier];
      if (typeof value === "number") {
        candidate[tier] = value + 99;
        return true;
      }
    }
  }
  return false;
}

const SURFACE_ID_KEYS = [
  "name",
  "title",
  "id",
  "slug",
  "key",
  "surface",
  "surfaceId",
  "surface_id",
] as const;

/** Human-readable surface label (prefer name — docs prose uses it, not ids). */
function surfaceIdentifier(
  surface: Record<string, unknown>,
): string | undefined {
  for (const key of SURFACE_ID_KEYS) {
    const value = surface[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  for (const value of Object.values(surface)) {
    if (typeof value === "string" && value.trim().length >= 8) {
      return value.trim();
    }
  }
  return undefined;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const LOW_SIGNAL_TOKENS = new Set([
  "with",
  "from",
  "into",
  "that",
  "this",
  "surface",
  "surfaces",
]);

/** True when the docs mention the surface by name or by enough of its tokens. */
function docsMentionSurface(haystack: string, identifier: string): boolean {
  const needle = normalize(identifier);
  if (haystack.includes(needle)) return true;
  const tokens = needle
    .split(" ")
    .filter((token) => token.length >= 4 && !LOW_SIGNAL_TOKENS.has(token));
  if (tokens.length === 0) return false;
  const matched = tokens.filter((token) => haystack.includes(token));
  return matched.length >= Math.min(2, tokens.length);
}

describe("evidence ledger invariants", () => {
  test("ledger.json exists and declares its schema", () => {
    const ledger = loadLedger();
    expect(typeof ledger.schemaVersion).toBe("number");
    expect(Array.isArray(ledger.operations)).toBe(true);
    expect(Array.isArray(ledger.surfaces)).toBe(true);
    expect(isRecord(ledger.counts)).toBe(true);
    expect(ledgerRows(ledger).length).toBeGreaterThan(0);
    expect((ledger.surfaces as unknown[]).length).toBeGreaterThan(0);
  });

  test("passes the ledger↔spec parity gate with zero issues", () => {
    const ledger = loadLedger();
    expectNoIssues(checkLedger(ledger, loadSpec()));
  });

  test("every spec operation is covered by the ledger with the same tier", () => {
    const ledger = loadLedger();
    const spec = loadSpec();
    const operations = operationsOf(spec);

    const missing: string[] = [];
    const tierMismatch: string[] = [];
    for (const operation of operations) {
      const key = `${operation.method.toUpperCase()} ${operation.path}`;
      const coverage = findOperationCoverage(
        ledger,
        operation.path,
        operation.method,
      );
      if (coverage === undefined) {
        missing.push(key);
        continue;
      }
      const evidence = operation.operation["x-evidence"];
      const specTier = isRecord(evidence) ? evidence.tier : undefined;
      if (coverage.tier !== undefined && specTier !== coverage.tier) {
        tierMismatch.push(
          `${key}: spec=${String(specTier)} ledger ${coverage.kind} ${coverage.label}=${coverage.tier}`,
        );
      }
    }
    expect(missing).toEqual([]);
    expect(tierMismatch).toEqual([]);

    // The ledger is append-only: retired rows are allowed only when they are
    // documented-not-implemented (tier E) or explicitly contradicted.
    const specKeys = new Set(
      operations.map(
        (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
      ),
    );
    const unexpectedStale = ledgerRows(ledger)
      .filter((row) => !specKeys.has(rowKey(row)))
      .filter((row) => row.tier !== "E" && row.contradicted !== true)
      .map(rowKey);
    expect(unexpectedStale).toEqual([]);
  });

  test("declared counts equal the actual ledger rows", () => {
    const ledger = loadLedger();
    const declared = declaredTierCounts(ledger.counts);
    if (declared === undefined) {
      throw new Error("ledger.counts does not declare per-tier counts");
    }
    const actual = new Map<string, number>();
    for (const tier of LEDGER_TIERS) actual.set(tier, 0);
    for (const row of ledgerRows(ledger)) {
      const tier = String(row.tier);
      actual.set(tier, (actual.get(tier) ?? 0) + 1);
    }
    for (const tier of LEDGER_TIERS) {
      const declaredCount = declared.get(tier);
      if (declaredCount === undefined) {
        if ((actual.get(tier) ?? 0) > 0) {
          throw new Error(
            `ledger.counts.${tier} missing but ${String(actual.get(tier))} row(s) have tier ${tier}`,
          );
        }
        continue;
      }
      expect(declaredCount).toBe(actual.get(tier) ?? 0);
    }
  });

  test("capture honesty: A ⇒ capturedResponse, GS row contradicted, getWebLog unknown", () => {
    const ledger = loadLedger();
    const rows = ledgerRows(ledger);
    for (const row of rows) {
      if (row.tier === "A") {
        expect(row.capturedResponse).toBe(true);
      }
      if (row.capturedResponse === true) {
        expect(["A", "B"]).toContain(String(row.tier));
      }
    }

    const webLog = rows.find((row) => /\/getWebLog$/i.test(String(row.path)));
    if (webLog === undefined) throw new Error("ledger has no getWebLog row");
    // The 2026-10-31 live capture resolved getWebLog's contradiction and made
    // it tier A with a captured response.
    expect(webLog.tier).toBe("A");
    expect(webLog.capturedResponse).toBe(true);

    const gsRow = rows.find((row) =>
      String(row.path).includes("/manager-tools/ajax.php"),
    );
    if (gsRow !== undefined) {
      expect(gsRow.contradicted).toBe(true);
      expect(gsRow.capturedResponse).toBe(false);
    } else {
      const spec = loadSpec();
      const paths = isRecord(spec.paths) ? Object.keys(spec.paths) : [];
      expect(paths).not.toContain("/manager-tools/ajax.php");
    }
  });

  test("every ledger surface is mentioned in the human docs", () => {
    const ledger = loadLedger();
    const surfaces = ledger.surfaces;
    if (!Array.isArray(surfaces)) throw new Error("ledger.surfaces missing");

    const docsText = [EVIDENCE_MD_PATH, GS_CONTRACTS_PATH]
      .filter((path) => existsSync(path))
      .map(readText)
      .join("\n");
    if (docsText.trim() === "") {
      throw new Error(
        "neither docs/EVIDENCE.md nor docs/gs-manager-contracts.md exists; surfaces cannot be surfaced",
      );
    }
    const haystack = normalize(docsText);

    const missing: string[] = [];
    for (const surface of surfaces) {
      if (!isRecord(surface)) continue;
      const identifier = surfaceIdentifier(surface);
      if (identifier === undefined) {
        missing.push(
          `(unnamed surface row: ${JSON.stringify(surface).slice(0, 80)})`,
        );
        continue;
      }
      if (!docsMentionSurface(haystack, identifier)) {
        missing.push(identifier);
      }
    }
    expect(missing).toEqual([]);
  });

  test("EVIDENCE.md explains the evidence model and limitation", () => {
    if (!existsSync(EVIDENCE_MD_PATH)) {
      throw new Error("docs/EVIDENCE.md missing");
    }
    const evidence = readText(EVIDENCE_MD_PATH);
    expect(evidence.length).toBeGreaterThan(500);
    expect(evidence).toMatch(/tier/i);
    expect(evidence).toMatch(/(captured|inferred)/i);
    expect(evidence).toMatch(/(limitation|limitations|not captured|blocked)/i);
  });

  test("gs-manager-contracts.md documents the blocked GS contract (no fake endpoints)", () => {
    if (!existsSync(GS_CONTRACTS_PATH)) {
      throw new Error(
        "docs/gs-manager-contracts.md missing — the GS manager-cli surfaces are blocked_contract, not HTTP endpoints",
      );
    }
    const contracts = readText(GS_CONTRACTS_PATH);
    expect(contracts).toMatch(/blocked/i);
    expect(contracts).toMatch(/(getBetReport|report kind|CLI)/i);
  });
});

describe("negative coverage — the ledger gate bites", () => {
  test("rejects a spec operation with no ledger row", () => {
    const mutated = structuredClone(loadLedger());
    const rows = mutated.operations;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("ledger has no operations to mutate");
    }
    rows.shift();

    const outcome = checkLedger(mutated, loadSpec());
    expect(outcome.status).toBe("fail");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      CODES.LEDGER_OP_MISSING,
    );
  });

  test("rejects a ledger tier that disagrees with x-evidence.tier", () => {
    const mutated = structuredClone(loadLedger());
    const rows = ledgerRows(mutated);
    const target = rows[0];
    if (target === undefined) throw new Error("ledger has no rows");
    target.tier = target.tier === "A" ? "B" : "A";

    const outcome = checkLedger(mutated, loadSpec());
    expect(outcome.status).toBe("fail");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      CODES.LEDGER_TIER_MISMATCH,
    );
  });

  test("rejects inflated declared counts", () => {
    const mutated = structuredClone(loadLedger());
    if (!bumpDeclaredCount(mutated)) {
      throw new Error("could not find a declared tier count to inflate");
    }

    const outcome = checkLedger(mutated, loadSpec());
    expect(outcome.status).toBe("fail");
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      CODES.LEDGER_COUNT_MISMATCH,
    );
  });
});
