#!/usr/bin/env bun
/**
 * generate_openapi.ts — deterministic, evidence-led OpenAPI 3.1 generator.
 *
 * Why this exists: docs/openapi.json used to be hand-authored. It advertised a
 * GS wire contract that the evidence package explicitly marks blocked_contract,
 * published an invented getWebLog response row schema, referenced a BearerAuth
 * scheme that was never declared, and documented /api/desk/* routes that no
 * code serves. This generator replaces that spec with one derived from
 * docs/evidence/ledger.json plus first-party sources:
 *
 *   - docs/evidence/ledger.json  (frozen: 48 operation rows, 8 surface rows)
 *   - docs/EVIDENCE.md           (binds each Tier D surface id to human docs)
 *   - fantasy402_sport_catalog.ts / simulate_bettor_churn_suite.ts (TS types)
 *   - tests/fixtures/fantasy402-sport-catalog-2026-10-21.json (catalog sample)
 *
 * Every operation carries x-evidence {tier, sources, capturedResponse,
 * requiredCapture?, contradicted?, candidateUrl?}. Tier C operations publish no
 * request body and no response content; Tier D operations reference a ledger
 * surfaces[] row by id. The generator self-gates through scripts/verify_docs.ts
 * (checkOpenApi + checkLedger) before writing, so the committed JSON can only be
 * what the docs gate would accept.
 *
 * Determinism: no timestamps, no randomness, no environment reads. The output is
 * JSON.stringify(spec, null, 2) + "\n" built from fixed code + sorted ledger
 * order, then reformatted in place with the repository's pinned bun formatter so
 * the committed file is also `bun fmt --check` clean. Running it twice yields
 * identical bytes; CI re-runs it and byte-diffs.
 *
 * Usage:
 *   bun run scripts/generate_openapi.ts            # write docs/openapi.json
 *   bun run scripts/generate_openapi.ts --out p    # write to another path
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { checkLedger, checkOpenApi } from "./verify_docs.ts";
import type { CheckOutcome } from "./verify_docs.ts";

/* -------------------------------------------------------------------------- */
/* Paths and release invariants                                               */
/* -------------------------------------------------------------------------- */

const ROOT = resolve(import.meta.dir, "..");
const LEDGER_PATH = join(ROOT, "docs", "evidence", "ledger.json");
const EVIDENCE_MD_PATH = join(ROOT, "docs", "EVIDENCE.md");
const DEFAULT_OUTPUT_PATH = join(ROOT, "docs", "openapi.json");
const CATALOG_TYPE_SOURCE = join(ROOT, "fantasy402_sport_catalog.ts");
const CHURN_TYPE_SOURCE = join(ROOT, "simulate_bettor_churn_suite.ts");
const CATALOG_FIXTURE = join(
  ROOT,
  "tests",
  "fixtures",
  "fantasy402-sport-catalog-2026-10-21.json",
);

/** The frozen P1 ledger this release was generated against. */
const EXPECTED_LEDGER_COUNTS = {
  A: 0,
  B: 7,
  C: 31,
  D: 0,
  E: 10,
  total: 48,
} as const;
const EXPECTED_SURFACE_COUNTS = { D: 7, E: 1, total: 8 } as const;
const EXPECTED_SPEC_OPERATIONS = 40;
const EXPECTED_SPEC_TIERS = { A: 0, B: 6, C: 31, D: 3 } as const;

const TAG_INFERRED = "Inferred (Unverified)";
const TAG_FORENSIC = "Forensic Surveillance";
const TAG_CUSTOMER = "Customer State Mutations";
const TAG_DAEMON = "Local Desk & Telegram Gateway";
const TAG_SETTLEMENT = "Settlement History";

const USED_TAGS = [
  TAG_FORENSIC,
  TAG_CUSTOMER,
  TAG_DAEMON,
  TAG_SETTLEMENT,
  TAG_INFERRED,
] as const;

/** The 11 hand-authored "Tracked Operational Domains" candidates. */
interface TileMetadata {
  readonly domTile: string;
  readonly domSelector: string;
  readonly extractedInputs: readonly string[];
  readonly languageKeys: readonly string[];
}

const TRACKED_TILE_METADATA: Readonly<Record<string, TileMetadata>> = {
  "/cloud/api/Manager/gameAdmin": {
    domTile: "Game Admin",
    domSelector: "div.tile:has-text('Game Admin')",
    extractedInputs: ["rotationNumber", "sportType", "circleLimit", "isLocked"],
    languageKeys: ["L-1034", "L-1052"],
  },
  "/cloud/api/System/getMessages": {
    domTile: "Messaging",
    domSelector: "div.tile:has-text('Messaging')",
    extractedInputs: ["recipientScope", "subject", "messageBody", "priority"],
    languageKeys: ["L-1055", "L-1056"],
  },
  "/cloud/api/Manager/adjustBalance": {
    domTile: "Cashier",
    domSelector: "div.tile:has-text('Cashier')",
    extractedInputs: ["customerID", "amountCents", "transactionType", "notes"],
    languageKeys: ["L-1031", "L-1045", "L-1058"],
  },
  "/cloud/api/Manager/createPlayer": {
    domTile: "Add Customer",
    domSelector: "div.tile:has-text('Add Customer')",
    extractedInputs: [
      "customerID",
      "agentID",
      "password",
      "creditLimit",
      "delaySeconds",
    ],
    languageKeys: ["L-1031", "L-1032", "L-1040"],
  },
  "/cloud/api/Manager/get3rdPartyLimits": {
    domTile: "3rd Party Limits",
    domSelector: "div.tile:has-text('3rd Party Limits')",
    extractedInputs: ["providerID", "sportCategory", "maxLimitCents"],
    languageKeys: ["L-1060", "L-1061"],
  },
  "/cloud/api/Report/getAnalysis": {
    domTile: "Analysis",
    domSelector: "div.tile:has-text('Analysis')",
    extractedInputs: ["period", "sport", "marketCategory", "agentID"],
    languageKeys: ["L-1034", "L-1064"],
  },
  "/cloud/api/Manager/getScores": {
    domTile: "Scores",
    domSelector: "div.tile:has-text('Scores')",
    extractedInputs: [
      "gameID",
      "periodIndex",
      "homeScore",
      "awayScore",
      "isFinal",
    ],
    languageKeys: ["L-1034", "L-1068"],
  },
  "/cloud/api/Manager/getAgentTree": {
    domTile: "Agent Admin",
    domSelector: "div.tile:has-text('Agent Admin')",
    extractedInputs: ["masterAgent", "commissionSplitPercent", "creditCeiling"],
    languageKeys: ["L-1032", "L-1070"],
  },
  "/cloud/api/Manager/getBilling": {
    domTile: "Billing",
    domSelector: "div.tile:has-text('Billing')",
    extractedInputs: ["billingWeek", "ratePerActiveHead", "activeAccountCount"],
    languageKeys: ["L-1050", "L-1072"],
  },
  "/cloud/api/Manager/getRules": {
    domTile: "Rules",
    domSelector: "div.tile:has-text('Rules')",
    extractedInputs: [
      "parlayMaxPayout",
      "teaserTieRule",
      "defaultDelaySeconds",
    ],
    languageKeys: ["L-1040", "L-1075"],
  },
  "/cloud/api/Report/getFinancialReport": {
    domTile: "Transactions History",
    domSelector: "div.tile:has-text('Transactions History')",
    extractedInputs: [
      "customerID",
      "startDate",
      "endDate",
      "transactionFilter",
    ],
    languageKeys: ["L-1031", "L-1033", "L-1058"],
  },
};

/** C operations backed by a repo consumer type -> the documented component. */
const REPO_TYPE_COMPONENTS: Readonly<Record<string, string>> = {
  "/cloud/api/Manager/getBetTicker": "RawBetTickerTick",
  "/cloud/api/Manager/getPending": "RawPendingLeg",
};

/** Human summaries; the path + evidence tier is the authoritative inventory. */
const SUMMARIES: Readonly<Record<string, string>> = {
  "/cloud/api/System/authenticateCustomer":
    "Authenticate agent/customer session",
  "/cloud/api/Manager/getBetTicker": "Bet ticker delta feed",
  "/cloud/api/Manager/getBetTickerConfig": "Ticker configuration",
  "/cloud/api/Manager/getPending": "Pending wager legs snapshot",
  "/cloud/api/Manager/getWebLog":
    "Manager getWebLog (mode B request observed; response not captured)",
  "/cloud/api/Manager/search": "Global account omnisearch",
  "/cloud/api/Manager/updateByColumn": "Padded-field customer mutation",
  "/cloud/api/Manager/getInfoPlayer":
    "Manager getInfoPlayer (request observed; response not captured)",
  "/cloud/api/Manager/vigSetupInsert": "Insert sport vig setup",
  "/cloud/api/Manager/getSportsVigSetup": "Read sport vig setup",
  "/cloud/api/Manager/getInfoManager": "Manager dashboard header",
  "/cloud/api/Report/getWeeklyFigure": "Weekly figure report",
  "/cloud/api/Report/getAgentPerformance": "Agent performance report",
  "/cloud/api/Report/getSettledFigure": "Settled figure / collections",
  "/cloud/api/Report/delete-wager": "Deleted wagers report",
  "/health": "Daemon health and telemetry probe",
  "/api/watchlist": "Monitored watch-list accounts",
  "/api/telegram/alert": "Dispatch an instant Telegram alert",
  "/api/telegram/report": "Trigger a scheduled Telegram report",
  "/cloud/api/System/verifySession": "Verify an existing session",
  "/cloud/api/Manager/getCustomerNotes": "Read customer notes",
  "/cloud/api/Manager/updateCustomerNotes": "Update customer notes",
  "/cloud/api/Manager/deleteSportsVigSetup": "Delete sport vig setup",
  "/cloud/api/Manager/deleteWager": "Delete a wager",
  "/cloud/api/Report/getDeletedWagerReport": "Deleted wager report",
  "/cloud/api/Report/getDailyFigure": "Daily figure report",
  "/cloud/api/Manager/gameAdmin": "Launcher tile: Game Admin",
  "/cloud/api/System/getMessages": "Launcher tile: Messaging",
  "/cloud/api/Manager/adjustBalance": "Launcher tile: Cashier",
  "/cloud/api/Manager/createPlayer": "Launcher tile: Add Customer",
  "/cloud/api/Manager/get3rdPartyLimits": "Launcher tile: 3rd Party Limits",
  "/cloud/api/Report/getAnalysis": "Launcher tile: Analysis",
  "/cloud/api/Manager/getScores": "Launcher tile: Scores",
  "/cloud/api/Manager/getAgentTree": "Launcher tile: Agent Admin",
  "/cloud/api/Manager/getBilling": "Launcher tile: Billing",
  "/cloud/api/Manager/getRules": "Launcher tile: Rules",
  "/cloud/api/Report/getFinancialReport": "Launcher tile: Transactions History",
};

/* -------------------------------------------------------------------------- */
/* Small typed JSON helpers                                                   */
/* -------------------------------------------------------------------------- */

type JsonObject = { [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`generate_openapi: ${message}`);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number`);
  }
  return value;
}

function asOptionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, label);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fail(`cannot read ${path}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Ledger model                                                               */
/* -------------------------------------------------------------------------- */

interface EvidenceEntry {
  readonly source: string;
  readonly kind: string;
  readonly note: string;
}

interface LedgerOperation {
  readonly path: string;
  readonly method: string;
  readonly operationId: string | null;
  readonly tag: string;
  readonly tier: string;
  readonly capturedResponse: boolean;
  readonly evidence: readonly EvidenceEntry[];
  readonly requiredCapture: string | null;
  readonly contradicted: boolean;
  readonly candidateUrl: boolean;
  readonly uiObserved: boolean;
}

interface LedgerSurface {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly evidence: readonly EvidenceEntry[];
}

interface LedgerCounts {
  readonly A: number;
  readonly B: number;
  readonly C: number;
  readonly D: number;
  readonly E: number;
  readonly total: number;
}

interface Ledger {
  readonly counts: LedgerCounts;
  readonly surfaceCounts: {
    readonly D: number;
    readonly E: number;
    readonly total: number;
  };
  readonly operations: readonly LedgerOperation[];
  readonly surfaces: readonly LedgerSurface[];
}

function parseEvidence(raw: unknown, label: string): EvidenceEntry[] {
  if (!Array.isArray(raw)) fail(`${label}.evidence must be an array`);
  return raw.map((entry, index) => {
    if (!isRecord(entry)) fail(`${label}.evidence[${index}] must be an object`);
    return {
      source: asString(entry.source, `${label}.evidence[${index}].source`),
      kind:
        typeof entry.kind === "string"
          ? entry.kind
          : fail(`${label}.evidence[${index}].kind must be a string`),
      note:
        typeof entry.note === "string"
          ? entry.note
          : fail(`${label}.evidence[${index}].note must be a string`),
    };
  });
}

function parseLedgerCounts(raw: unknown): LedgerCounts {
  if (!isRecord(raw)) fail("ledger.counts must be an object");
  return {
    A: asNumber(raw.A, "counts.A"),
    B: asNumber(raw.B, "counts.B"),
    C: asNumber(raw.C, "counts.C"),
    D: asNumber(raw.D, "counts.D"),
    E: asNumber(raw.E, "counts.E"),
    total: asNumber(raw.total, "counts.total"),
  };
}

function parseLedger(raw: unknown): Ledger {
  if (!isRecord(raw)) fail("ledger.json must contain an object");
  const rawOperations = raw.operations;
  if (!Array.isArray(rawOperations)) {
    fail("ledger.operations must be an array");
  }
  const operations: LedgerOperation[] = rawOperations.map((row, index) => {
    if (!isRecord(row)) fail(`ledger.operations[${index}] must be an object`);
    const label = `ledger.operations[${index}]`;
    return {
      path: asString(row.path, `${label}.path`),
      method: asString(row.method, `${label}.method`),
      operationId: asOptionalString(row.operationId, `${label}.operationId`),
      tag: asString(row.tag, `${label}.tag`),
      tier: asString(row.tier, `${label}.tier`),
      capturedResponse: asBoolean(
        row.capturedResponse,
        `${label}.capturedResponse`,
      ),
      evidence: parseEvidence(row.evidence, label),
      requiredCapture: asOptionalString(
        row.requiredCapture,
        `${label}.requiredCapture`,
      ),
      contradicted: asBoolean(row.contradicted, `${label}.contradicted`),
      candidateUrl: row.candidate_url === true,
      uiObserved: row.ui_observed === true,
    };
  });

  const rawSurfaces = raw.surfaces;
  if (!Array.isArray(rawSurfaces)) fail("ledger.surfaces must be an array");
  const surfaces: LedgerSurface[] = rawSurfaces.map((row, index) => {
    if (!isRecord(row)) fail(`ledger.surfaces[${index}] must be an object`);
    const label = `ledger.surfaces[${index}]`;
    return {
      id: asString(row.id, `${label}.id`),
      name: asString(row.name, `${label}.name`),
      tier: asString(row.tier, `${label}.tier`),
      evidence: parseEvidence(row.evidence, label),
    };
  });

  if (!isRecord(raw.surfaceCounts))
    fail("ledger.surfaceCounts must be an object");
  return {
    counts: parseLedgerCounts(raw.counts),
    surfaceCounts: {
      D: asNumber(raw.surfaceCounts.D, "surfaceCounts.D"),
      E: asNumber(raw.surfaceCounts.E, "surfaceCounts.E"),
      total: asNumber(raw.surfaceCounts.total, "surfaceCounts.total"),
    },
    operations,
    surfaces,
  };
}

function assertFrozenLedger(ledger: Ledger): void {
  const actual = ledger.counts;
  for (const tier of ["A", "B", "C", "D", "E", "total"] as const) {
    const expected = EXPECTED_LEDGER_COUNTS[tier];
    const found = actual[tier];
    if (expected !== found) {
      fail(
        `frozen ledger drift: counts.${tier} is ${found}, expected ${expected}; re-baseline the release before generating`,
      );
    }
  }
  for (const tier of ["D", "E", "total"] as const) {
    const expected = EXPECTED_SURFACE_COUNTS[tier];
    const found = ledger.surfaceCounts[tier];
    if (expected !== found) {
      fail(
        `frozen ledger drift: surfaceCounts.${tier} is ${found}, expected ${expected}`,
      );
    }
  }
  if (ledger.operations.length !== EXPECTED_LEDGER_COUNTS.total) {
    fail(
      `frozen ledger drift: ${ledger.operations.length} operation rows, expected ${EXPECTED_LEDGER_COUNTS.total}`,
    );
  }
}

function findSurface(ledger: Ledger, surfaceId: string): LedgerSurface {
  const surface = ledger.surfaces.find((row) => row.id === surfaceId);
  if (surface === undefined) {
    fail(`ledger has no surfaces[] row "${surfaceId}"`);
  }
  return surface;
}

/* -------------------------------------------------------------------------- */
/* TypeScript source parsing (real types, not re-authored field lists)        */
/* -------------------------------------------------------------------------- */

interface ParsedField {
  readonly name: string;
  readonly optional: boolean;
  readonly typeText: string;
  readonly description: string | null;
}

interface ParsedType {
  readonly name: string;
  readonly fileName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly fields: readonly ParsedField[];
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Skip over strings and comments while scanning a type body. */
function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === "/" && text.charAt(index + 1) === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (character === "/" && text.charAt(index + 1) === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      index += 1;
      while (index < text.length) {
        const inner = text.charAt(index);
        if (inner === "\\") {
          index += 1;
          continue;
        }
        if (inner === quote) break;
        index += 1;
      }
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return fail("unbalanced braces while parsing a TypeScript type");
}

function normalizeDoc(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s*/, "")
    .replace(/\s*\/\*\*?|\*\/\s*$/g, "")
    .trim();
}

const PROPERTY_PATTERN =
  /^(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(\?)?\s*:\s*(.+)$/;

function parseTypeDeclaration(
  source: string,
  fileName: string,
  typeName: string,
): ParsedType {
  const interfaceMatch = new RegExp(
    `export\\s+interface\\s+${typeName}\\b`,
  ).exec(source);
  const typeMatch = new RegExp(`export\\s+type\\s+${typeName}\\s*=`).exec(
    source,
  );
  const candidates = [interfaceMatch, typeMatch].filter(
    (match): match is RegExpExecArray => match !== null,
  );
  if (candidates.length !== 1) {
    fail(
      `${fileName}: expected exactly one declaration of ${typeName}, found ${candidates.length}`,
    );
  }
  const declaration = candidates[0];
  if (declaration === undefined) fail(`${fileName}: ${typeName} not found`);
  const openIndex = source.indexOf("{", declaration.index);
  if (openIndex === -1) {
    fail(
      `${fileName}: ${typeName} has no object body (expected a record type)`,
    );
  }
  const closeIndex = findMatchingBrace(source, openIndex);
  const body = source.slice(openIndex + 1, closeIndex);
  const bodyStartLine = lineAt(source, openIndex);
  const fields: ParsedField[] = [];
  let pendingDoc: string[] = [];
  let inDoc = false;

  for (const [offset, rawLine] of body.split("\n").entries()) {
    const line = rawLine.trim();
    const lineNumber = bodyStartLine + offset;
    if (line === "") continue;
    if (inDoc) {
      if (/^\*?\s*\*\/$/.test(line)) {
        inDoc = false;
        continue;
      }
      pendingDoc.push(normalizeDoc(line.replace(/^\*\s?/, "")));
      continue;
    }
    if (line.startsWith("/**")) {
      const sameLine = /^\/\*\*\s*(.*?)\s*\*\/$/.exec(line);
      if (sameLine !== null) {
        pendingDoc.push(normalizeDoc(sameLine[1] ?? ""));
      } else {
        inDoc = true;
        pendingDoc.push(normalizeDoc(line.replace(/^\/\*\*\s*/, "")));
      }
      continue;
    }
    if (line.startsWith("//")) {
      pendingDoc.push(normalizeDoc(line.replace(/^\/\/\s*/, "")));
      continue;
    }
    const match = PROPERTY_PATTERN.exec(line);
    if (match === null) {
      fail(
        `${fileName}:${lineNumber}: cannot parse ${typeName} property "${line}"`,
      );
    }
    const name = match[1];
    if (name === undefined)
      fail(`${fileName}:${lineNumber}: missing field name`);
    const optional = match[2] === "?";
    let typeText = (match[3] ?? "").trim();
    let inlineComment: string | null = null;
    const commentIndex = typeText.indexOf("//");
    if (commentIndex !== -1) {
      inlineComment = normalizeDoc(typeText.slice(commentIndex + 2));
      typeText = typeText.slice(0, commentIndex).trim();
    }
    if (typeText.endsWith(";")) typeText = typeText.slice(0, -1).trim();
    if (typeText === "") {
      fail(`${fileName}:${lineNumber}: ${typeName}.${name} has no type`);
    }
    const description =
      inlineComment !== null && inlineComment !== ""
        ? inlineComment
        : pendingDoc.length > 0
          ? normalizeDoc(pendingDoc.join(" "))
          : null;
    pendingDoc = [];
    fields.push({ name, optional, typeText, description });
  }
  return {
    name: typeName,
    fileName,
    startLine: lineAt(source, declaration.index),
    endLine: lineAt(source, closeIndex),
    fields,
  };
}

/** Parse `export type Name = "a" | "b" | ...;` into its string-literal values. */
function parseStringUnionAlias(
  source: string,
  fileName: string,
  aliasName: string,
): string[] {
  const match = new RegExp(`export\\s+type\\s+${aliasName}\\s*=`).exec(source);
  if (match === null) fail(`${fileName}: ${aliasName} alias not found`);
  const rest = source.slice(match.index + match[0].length);
  const semicolon = rest.indexOf(";");
  const bodyText = semicolon === -1 ? rest : rest.slice(0, semicolon);
  const values = Array.from(bodyText.matchAll(/"([^"\\]*)"/g), (entry) => {
    const value = entry[1];
    if (value === undefined) fail(`${fileName}: bad literal in ${aliasName}`);
    return value;
  });
  if (values.length === 0) {
    fail(`${fileName}: ${aliasName} has no string literals`);
  }
  const residual = bodyText.replace(/"[^"\\]*"/g, "").replace(/[|\s]/g, "");
  if (residual !== "") {
    fail(`${fileName}: ${aliasName} is not a pure string-literal union`);
  }
  return values;
}

/* -------------------------------------------------------------------------- */
/* TS type -> JSON Schema                                                     */
/* -------------------------------------------------------------------------- */

interface SchemaBuilderContext {
  readonly aliases: ReadonlyMap<string, readonly string[]>;
  readonly componentNameFor: (sourceTypeName: string) => string;
}

function isNamedSourceType(
  typeText: string,
  context: SchemaBuilderContext,
): boolean {
  return (
    /^[A-Z][A-Za-z0-9]*$/.test(typeText) &&
    context.componentNameFor(typeText) !== ""
  );
}

function typeToSchema(
  typeText: string,
  context: SchemaBuilderContext,
): JsonObject {
  const text = typeText.trim();
  if (text.endsWith("[]")) {
    const base = text.slice(0, -2).trim();
    return { type: "array", items: typeToSchema(base, context) };
  }
  const alias = context.aliases.get(text);
  if (alias !== undefined) return { type: "string", enum: [...alias] };
  const unionParts = text.split("|").map((part) => part.trim());
  if (unionParts.length > 1) {
    const knownValues: string[] = [];
    let hasFreeString = false;
    for (const part of unionParts) {
      const literal = /^"([^"\\]*)"$/.exec(part);
      if (literal !== null) {
        knownValues.push(literal[1] ?? "");
        continue;
      }
      if (part === "string") {
        hasFreeString = true;
        continue;
      }
      const aliasValues = context.aliases.get(part);
      if (aliasValues !== undefined) {
        knownValues.push(...aliasValues);
        continue;
      }
      fail(`unsupported union type "${text}" (part "${part}")`);
    }
    if (knownValues.length === 0 && hasFreeString) return { type: "string" };
    if (hasFreeString) {
      return {
        type: "string",
        description: `Wire value or free string. Known values: ${knownValues.join(" | ")}`,
      };
    }
    if (knownValues.length > 0) return { type: "string", enum: knownValues };
    fail(`unsupported union type "${text}"`);
  }
  switch (text) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "integer":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "Record<string, string>":
      return { type: "object", additionalProperties: { type: "string" } };
    default:
      break;
  }
  if (isNamedSourceType(text, context)) {
    return { $ref: `#/components/schemas/${context.componentNameFor(text)}` };
  }
  return fail(`unsupported TypeScript type "${text}"`);
}

interface ComponentTypeSpec {
  readonly sourceType: string;
  readonly componentName: string;
  readonly source: string;
  readonly fileName: string;
  readonly description: string;
}

function buildSchemaFromType(
  spec: ComponentTypeSpec,
  context: SchemaBuilderContext,
): JsonObject {
  const parsed = parseTypeDeclaration(
    spec.source,
    spec.fileName,
    spec.sourceType,
  );
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const field of parsed.fields) {
    const schema = typeToSchema(field.typeText, context);
    if (field.description !== null && field.description !== "") {
      schema.description = field.description;
    }
    properties[field.name] = schema;
    if (!field.optional) required.push(field.name);
  }
  const schema: JsonObject = {
    type: "object",
    description: `${spec.description} Parsed from ${spec.fileName}:${parsed.startLine}-${parsed.endLine}.`,
    properties,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

/* -------------------------------------------------------------------------- */
/* Catalog fixture validation + schema assembly                               */
/* -------------------------------------------------------------------------- */

interface CatalogFixture {
  readonly provider: string;
  readonly capturedAt: string;
  readonly periodsCapturedAt: string;
  readonly sportCount: number;
  readonly subSportCount: number;
  readonly sportPeriodCount: number;
  readonly sports: readonly {
    readonly sport: string;
    readonly subSports: readonly unknown[];
    readonly periods: readonly unknown[];
  }[];
  readonly collisions: readonly {
    readonly code: string;
    readonly sports: readonly string[];
  }[];
}

function parseCatalogFixture(raw: unknown): CatalogFixture {
  if (!isRecord(raw)) fail("catalog fixture must be an object");
  if (!Array.isArray(raw.sports))
    fail("catalog fixture sports must be an array");
  if (!Array.isArray(raw.collisions)) {
    fail("catalog fixture collisions must be an array");
  }
  return {
    provider: asString(raw.provider, "catalog.provider"),
    capturedAt: asString(raw.capturedAt, "catalog.capturedAt"),
    periodsCapturedAt: asString(
      raw.periodsCapturedAt,
      "catalog.periodsCapturedAt",
    ),
    sportCount: asNumber(raw.sportCount, "catalog.sportCount"),
    subSportCount: asNumber(raw.subSportCount, "catalog.subSportCount"),
    sportPeriodCount: asNumber(
      raw.sportPeriodCount,
      "catalog.sportPeriodCount",
    ),
    sports: raw.sports.map((entry, index) => {
      if (!isRecord(entry)) fail(`catalog.sports[${index}] must be an object`);
      if (!Array.isArray(entry.subSports)) {
        fail(`catalog.sports[${index}].subSports must be an array`);
      }
      if (!Array.isArray(entry.periods)) {
        fail(`catalog.sports[${index}].periods must be an array`);
      }
      return {
        sport: asString(entry.sport, `catalog.sports[${index}].sport`),
        subSports: entry.subSports,
        periods: entry.periods,
      };
    }),
    collisions: raw.collisions.map((entry, index) => {
      if (!isRecord(entry))
        fail(`catalog.collisions[${index}] must be an object`);
      if (!Array.isArray(entry.sports)) {
        fail(`catalog.collisions[${index}].sports must be an array`);
      }
      return {
        code: asString(entry.code, `catalog.collisions[${index}].code`),
        sports: entry.sports.map((sport, sportIndex) =>
          asString(sport, `catalog.collisions[${index}].sports[${sportIndex}]`),
        ),
      };
    }),
  };
}

function validateCatalogFixture(fixture: CatalogFixture): {
  readonly computedSubSports: number;
  readonly computedPeriods: number;
} {
  const computedSubSports = fixture.sports.reduce(
    (total, sport) => total + sport.subSports.length,
    0,
  );
  const computedPeriods = fixture.sports.reduce(
    (total, sport) => total + sport.periods.length,
    0,
  );
  const checks: readonly [string, number, number][] = [
    ["sportCount", fixture.sportCount, fixture.sports.length],
    ["subSportCount", fixture.subSportCount, computedSubSports],
    ["sportPeriodCount", fixture.sportPeriodCount, computedPeriods],
  ];
  for (const [field, declared, computed] of checks) {
    if (declared !== computed) {
      fail(
        `catalog fixture drift: ${field}=${declared} but the tree contains ${computed}`,
      );
    }
  }
  if (fixture.collisions.length !== 2) {
    fail(
      `catalog fixture collision registry has ${fixture.collisions.length} ids, expected 2 (Arena, NCAA Extra)`,
    );
  }
  if (fixture.capturedAt > fixture.periodsCapturedAt) {
    fail(
      "catalog fixture timestamps are inverted (capturedAt after periodsCapturedAt)",
    );
  }
  return { computedSubSports, computedPeriods };
}

function buildCatalogSchema(
  context: SchemaBuilderContext,
  fixture: CatalogFixture,
  counts: {
    readonly computedSubSports: number;
    readonly computedPeriods: number;
  },
): JsonObject {
  const base = buildSchemaFromType(
    {
      sourceType: "Fantasy402SportCatalog",
      componentName: "Fantasy402SportCatalog",
      source: readText(CATALOG_TYPE_SOURCE),
      fileName: "fantasy402_sport_catalog.ts",
      description:
        "Fantasy402 desk navigation catalog (sub-sport lanes plus per-sport period menus). Reference metadata only, not an ingestion audit record. Surface: surface.fantasy402-sport-catalog (tier D).",
    },
    context,
  );
  base["x-fixture"] = {
    path: "tests/fixtures/fantasy402-sport-catalog-2026-10-21.json",
    provider: fixture.provider,
    capturedAt: fixture.capturedAt,
    periodsCapturedAt: fixture.periodsCapturedAt,
    sportCount: fixture.sports.length,
    subSportCount: counts.computedSubSports,
    sportPeriodCount: counts.computedPeriods,
    collisionIds: fixture.collisions.map((collision) => collision.code),
    caveat:
      "Committed SSOT sample, not a raw wire capture. capturedAt/periodsCapturedAt are fixture-declared.",
  };
  return base;
}

/* -------------------------------------------------------------------------- */
/* Operation builders                                                         */
/* -------------------------------------------------------------------------- */

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

function isHttpMethod(method: string): method is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(method);
}

function operationIdFor(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) =>
      segment
        .split(/[^A-Za-z0-9]+/)
        .filter((token) => token !== "")
        .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
        .join(""),
    )
    .filter((segment) => segment !== "");
  return `${method}${segments.join("")}`;
}

function evidenceOf(operation: LedgerOperation): JsonObject {
  const evidence: JsonObject = {
    tier: operation.tier,
    sources: operation.evidence.map((entry) => entry.source),
    capturedResponse: operation.capturedResponse,
  };
  if (operation.requiredCapture !== null) {
    evidence.requiredCapture = operation.requiredCapture;
  }
  if (operation.contradicted) evidence.contradicted = true;
  if (operation.candidateUrl) evidence.candidateUrl = true;
  return evidence;
}

function evidenceFromSurface(
  surface: LedgerSurface,
  requiredCapture: string,
): JsonObject {
  return {
    tier: surface.tier,
    sources: surface.evidence.map((entry) => entry.source),
    capturedResponse: false,
    requiredCapture,
  };
}

function daemonErrorSchema(): JsonObject {
  return {
    type: "object",
    required: ["success", "error"],
    properties: {
      success: { type: "boolean", const: false },
      error: { type: "string" },
    },
  };
}

function daemonHeaders(): JsonObject {
  return {
    "Content-Security-Policy": { $ref: "#/components/headers/CSPHeader" },
    "X-Content-Type-Options": {
      $ref: "#/components/headers/XContentTypeOptionsHeader",
    },
    "Referrer-Policy": {
      $ref: "#/components/headers/ReferrerPolicyHeader",
    },
  };
}

function daemonSuccessResponse(
  description: string,
  schema: JsonObject,
): JsonObject {
  return {
    description,
    headers: daemonHeaders(),
    content: { "application/json": { schema } },
  };
}

function adminRejectionResponses(): JsonObject {
  return {
    "401": {
      description:
        "Missing or wrong admin token (sportsdesk_webview_server.ts:38-46).",
      headers: daemonHeaders(),
      content: { "application/json": { schema: daemonErrorSchema() } },
    },
    "503": {
      description:
        "SPORTSDESK_ADMIN_TOKEN is not set on the server (sportsdesk_webview_server.ts:31-37).",
      headers: daemonHeaders(),
      content: { "application/json": { schema: daemonErrorSchema() } },
    },
  };
}

function inferredDescription(operation: LedgerOperation): string {
  const candidate = operation.candidateUrl;
  const repoTypeSources = operation.evidence
    .filter((entry) => entry.kind === "repo-type")
    .map((entry) => entry.source);
  const candidateClause = candidate
    ? "The path and method are candidate values inferred from a UI/DOM observation; they were never observed on the wire. "
    : "The path, method and any previously published field schema were authored in the prior hand-built spec or its generators; no request or response artifact exists in this repository. ";
  const repoTypeComponent = REPO_TYPE_COMPONENTS[operation.path];
  const repoTypeClause =
    repoTypeSources.length > 0
      ? `Repo type evidence: ${repoTypeSources.join(", ")} (a consumer type declaration, not a capture).${
          repoTypeComponent !== undefined
            ? ` See the ${repoTypeComponent} component; it records the field names only and is not used as a response schema here.`
            : ""
        } `
      : "";
  const tileClause =
    TRACKED_TILE_METADATA[operation.path] !== undefined
      ? "The launcher-tile DOM metadata (x-dom-tile, x-dom-selector, x-extracted-inputs) is UI observation only and must not be read as wire parameters. "
      : "";
  return (
    "UNVERIFIED — no capture exists. " +
    candidateClause +
    repoTypeClause +
    tileClause +
    "The request body and the response body/status codes are unknown, so no request schema and no response content are published here."
  );
}

function inferredOperation(
  operation: LedgerOperation,
  summary: string,
): JsonObject {
  const builder: JsonObject = {
    tags: [TAG_INFERRED],
    summary,
    description: inferredDescription(operation),
    operationId: operationIdFor(operation.method, operation.path),
    responses: {
      default: {
        description:
          "Unknown — no response was captured, so no status code or body schema is documented.",
      },
    },
    "x-evidence": evidenceOf(operation),
  };
  const tile = TRACKED_TILE_METADATA[operation.path];
  if (tile !== undefined) {
    builder["x-discovery-status"] = "UNDER_SURVEILLANCE";
    builder["x-dom-tile"] = tile.domTile;
    builder["x-dom-selector"] = tile.domSelector;
    builder["x-extracted-inputs"] = [...tile.extractedInputs];
    builder["x-data-language-keys"] = [...tile.languageKeys];
  }
  return builder;
}

function getWebLogOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_FORENSIC],
    summary:
      "Manager getWebLog (mode B request observed; response not captured)",
    description:
      "The forensic IP-investigation endpoint (operational_guardrails_runbook.md §5.1.1). Request side: a 2026-10-28 Manager HAR (portal v1.0.279) captured one mode-B POST with a form-urlencoded body and no Authorization header, so the session is cookie-based. Only mode B was captured; modes A, C and I are inferred from the portal form and still need a capture. Response side: no response body was captured, so the row schema is undocumented and none is published here. The WeblogEntry component (simulate_bettor_churn_suite.ts:117-123) records the four fields the old spec published, but a consumer type is not a capture, so it is not used as a response schema.",
    operationId: operationIdFor(operation.method, operation.path),
    parameters: [{ $ref: "#/components/parameters/XRequestedWith" }],
    requestBody: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            required: [
              "agentID",
              "customerID",
              "start",
              "end",
              "type",
              "actions",
              "ip",
              "operation",
              "RRO",
              "agentOwner",
            ],
            properties: {
              agentID: {
                type: "string",
                description:
                  "Session master agent; the captured value is redacted here.",
                example: "<redacted>",
              },
              customerID: {
                type: "string",
                description:
                  "0 = whole book. Mode C should carry the target account (unverified).",
                example: "0",
              },
              start: {
                type: "string",
                description:
                  "Inclusive start date. Observed as MM/DD/YYYY in mode B; mode C reportedly sends YYYY-MM-DD (unverified).",
                example: "10/28/2026",
              },
              end: {
                type: "string",
                description:
                  "Inclusive end date. Observed as MM/DD/YYYY in mode B; mode C reportedly sends YYYY-MM-DD (unverified).",
                example: "10/28/2026",
              },
              type: {
                type: "string",
                enum: ["A", "B", "C", "I"],
                description:
                  "A: web access log; B: global IP matcher; C: account IP match; I: users by IP. Only B was captured; A, C and I are inferred.",
              },
              actions: {
                type: "string",
                enum: ["ALL"],
                description:
                  "Action filter. ALL was observed; other values are unobserved.",
                example: "ALL",
              },
              ip: {
                type: "string",
                description:
                  "Empty in the observed mode-B request; mode I should carry the IP or /24 prefix (unverified).",
                example: "",
              },
              operation: {
                type: "string",
                enum: ["getWebLog"],
                description: "Echo of the method name.",
              },
              RRO: {
                type: "string",
                enum: ["1"],
                description: "Observed as 1; the meaning is unknown.",
              },
              agentOwner: {
                type: "string",
                description:
                  "Session master agent; the captured value is redacted here.",
                example: "<redacted>",
              },
            },
          },
        },
      },
    },
    security: [{ fantasy402Cookie: [] }],
    responses: {
      "200": {
        description: "Response body was not captured; row schema undocumented",
      },
    },
    "x-evidence": evidenceOf(operation),
  };
}

function getInfoPlayerOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_CUSTOMER],
    summary: "Manager getInfoPlayer (request observed; response not captured)",
    description:
      "Read observed in the 2026-10-28 Manager HAR: opening a player sent a form POST with a 7-character trimmed customerID (e.g. CB112_1, not the padded 11-character form the old spec showed), and agentID/agentOwner were the logged-in master on all 19 Manager calls (operational_guardrails_runbook.md:213-214). The response was not captured, so no response schema is published. Ledger contradicted: the prior spec's padded example is refuted by the capture.",
    operationId: operationIdFor(operation.method, operation.path),
    requestBody: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            additionalProperties: true,
            description:
              "Opaque: a form POST was observed, but only the trimmed customerID and master agentID/agentOwner values are recorded for this call, so the full field list is not published.",
          },
        },
      },
    },
    security: [{ fantasy402Cookie: [] }],
    responses: {
      default: {
        description:
          "Unknown — the response body was not captured; no status code or body schema is documented.",
      },
    },
    "x-evidence": evidenceOf(operation),
  };
}

function healthOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_DAEMON],
    summary: "Daemon health and telemetry probe",
    description:
      "Handler-defined contract: sportsdesk_webview_server.ts:114-131 returns the daemon's status, bound port/hostname, Bun-reported URL, timestamp, uptime, runtime and NODE_ENV. Verified against the handler source, not an HTTP capture. The daemon binds 0.0.0.0 by default (sportsdesk_webview_server.ts:9,345), so the example hostname is 0.0.0.0; the http://127.0.0.1:4020 server target is a loopback client view of that bind.",
    operationId: operationIdFor(operation.method, operation.path),
    responses: {
      "200": daemonSuccessResponse("Healthy daemon status", {
        type: "object",
        required: [
          "status",
          "port",
          "hostname",
          "url",
          "timestamp",
          "uptimeSeconds",
          "runtime",
          "nodeEnv",
        ],
        properties: {
          status: { type: "string", example: "healthy" },
          port: {
            type: "integer",
            description: "Bound port; PORT defaults to 4020.",
            example: 4020,
          },
          hostname: {
            type: "string",
            description:
              "Bound hostname. Bun serves on all interfaces by default (0.0.0.0).",
            example: "0.0.0.0",
          },
          url: {
            type: "string",
            description:
              "server.url as reported by Bun; with hostname 0.0.0.0 the daemon is reachable on all interfaces.",
            example: "http://0.0.0.0:4020/",
          },
          timestamp: {
            type: "string",
            format: "date-time",
            example: "2026-10-30T00:00:00.000Z",
          },
          uptimeSeconds: { type: "integer", example: 1240 },
          runtime: { type: "string", example: "Bun v1.4.4" },
          nodeEnv: { type: "string", example: "production" },
        },
      }),
    },
    "x-evidence": evidenceOf(operation),
  };
}

function watchlistOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_DAEMON],
    summary: "Monitored watch-list accounts",
    description:
      "Returns {success, count, data} from telegramService.getWatchList() (sportsdesk_webview_server.ts:236-246). Requires Authorization: Bearer <SPORTSDESK_ADMIN_TOKEN>; adminRejection returns 503 when the token is unset and 401 otherwise (sportsdesk_webview_server.ts:27-47,175-186).",
    operationId: operationIdFor(operation.method, operation.path),
    security: [{ daemonBearer: [] }],
    responses: {
      "200": daemonSuccessResponse("Watch-list snapshot", {
        type: "object",
        required: ["success", "count", "data"],
        properties: {
          success: { type: "boolean", const: true },
          count: { type: "integer" },
          data: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              description:
                "Opaque watch-list entry owned by sportsdesk_telegram_bot.ts; its shape was not captured.",
            },
          },
        },
      }),
      ...adminRejectionResponses(),
    },
    "x-evidence": evidenceOf(operation),
  };
}

function telegramAlertOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_DAEMON],
    summary: "Dispatch an instant Telegram alert",
    description:
      "Request body {customerId?} defaults to RF2003; dispatches through telegramService.dispatchTestAlert and returns {success, ok, customerId} (sportsdesk_webview_server.ts:249-274). Admin-token gated (sportsdesk_webview_server.ts:175-186).",
    operationId: operationIdFor(operation.method, operation.path),
    security: [{ daemonBearer: [] }],
    requestBody: {
      required: false,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              customerId: {
                type: "string",
                description: "Customer to alert; defaults to RF2003.",
                example: "RF2003",
              },
            },
          },
        },
      },
    },
    responses: {
      "200": daemonSuccessResponse("Alert dispatch result", {
        type: "object",
        required: ["success", "ok", "customerId"],
        properties: {
          success: { type: "boolean" },
          ok: {
            type: "boolean",
            description: "Whether Telegram accepted the alert.",
          },
          customerId: { type: "string" },
        },
      }),
      "500": {
        description: "Dispatch threw (sportsdesk_webview_server.ts:264-273).",
        headers: daemonHeaders(),
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["success", "ok", "error"],
              properties: {
                success: { type: "boolean", const: false },
                ok: { type: "boolean", const: false },
                error: { type: "string" },
              },
            },
          },
        },
      },
      ...adminRejectionResponses(),
    },
    "x-evidence": evidenceOf(operation),
  };
}

function telegramReportOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_DAEMON],
    summary: "Trigger a scheduled Telegram report",
    description:
      "Report type is selected by the ?type= query parameter and defaults to EVENING_SETTLEMENT; the handler validates it with isReportType and returns {success, ok, reportType} (sportsdesk_webview_server.ts:277-297). REPORT_TYPES are MORNING_BRIEFING, MIDDAY_STEAM and EVENING_SETTLEMENT (sportsdesk_telegram_bot.ts:77-81). Admin-token gated (sportsdesk_webview_server.ts:175-186).",
    operationId: operationIdFor(operation.method, operation.path),
    security: [{ daemonBearer: [] }],
    parameters: [
      {
        name: "type",
        in: "query",
        required: false,
        description:
          "Report type; defaults to EVENING_SETTLEMENT when absent (sportsdesk_webview_server.ts:278).",
        schema: {
          type: "string",
          enum: ["MORNING_BRIEFING", "MIDDAY_STEAM", "EVENING_SETTLEMENT"],
          default: "EVENING_SETTLEMENT",
        },
      },
    ],
    responses: {
      "200": daemonSuccessResponse("Report dispatch result", {
        type: "object",
        required: ["success", "ok", "reportType"],
        properties: {
          success: { type: "boolean" },
          ok: {
            type: "boolean",
            description: "Whether Telegram accepted the report.",
          },
          reportType: {
            type: "string",
            enum: ["MORNING_BRIEFING", "MIDDAY_STEAM", "EVENING_SETTLEMENT"],
          },
        },
      }),
      "400": {
        description:
          "type is not one of REPORT_TYPES (sportsdesk_webview_server.ts:279-287).",
        headers: daemonHeaders(),
        content: { "application/json": { schema: daemonErrorSchema() } },
      },
      ...adminRejectionResponses(),
    },
    "x-evidence": evidenceOf(operation),
  };
}

const B_OPERATION_BUILDERS: Readonly<
  Record<string, (operation: LedgerOperation) => JsonObject>
> = {
  "/cloud/api/Manager/getWebLog": getWebLogOperation,
  "/cloud/api/Manager/getInfoPlayer": getInfoPlayerOperation,
  "/health": healthOperation,
  "/api/watchlist": watchlistOperation,
  "/api/telegram/alert": telegramAlertOperation,
  "/api/telegram/report": telegramReportOperation,
};

/* -------------------------------------------------------------------------- */
/* Tier D surface operations                                                  */
/* -------------------------------------------------------------------------- */

/** Uppercase HTTP method on a surface spec; mapped to the lowercase path-item key at build time. */
type SurfaceHttpMethod = "GET" | "POST";

/** Map an uppercase surface method to its OpenAPI path-item key (always lowercase). */
function pathItemMethod(httpMethod: SurfaceHttpMethod): HttpMethod {
  switch (httpMethod) {
    case "GET":
      return "get";
    case "POST":
      return "post";
    default:
      return fail(`unsupported surface HTTP method "${String(httpMethod)}"`);
  }
}

interface SurfaceOperationSpec {
  readonly path: string;
  readonly httpMethod: SurfaceHttpMethod;
  readonly surfaceId: string;
  readonly tag: string;
  readonly summary: string;
  readonly description: string;
  readonly requiredCapture: string;
  readonly responses: JsonObject;
  readonly requestBody?: JsonObject;
}

function htmlResponse(description: string, contentType: string): JsonObject {
  return {
    description,
    headers: daemonHeaders(),
    content: {
      [contentType]: {
        schema: {
          type: "string",
          description: "Static HTML document served from disk by the daemon.",
        },
      },
    },
  };
}

function surfaceOperationSpecs(
  ledger: Ledger,
): readonly SurfaceOperationSpec[] {
  const historySurface = findSurface(ledger, "surface.manager-getHistory");
  return [
    {
      path: "/cloud/api/Manager/getHistory",
      httpMethod: "POST",
      surfaceId: historySurface.id,
      tag: TAG_SETTLEMENT,
      summary:
        "Manager getHistory (wired settlement-history poll; no response capture)",
      description:
        "The only upstream Fantasy402 route in this repository with a real fetch client: resolveHistoryPollUrl builds `${SPORTSDESK_PORTAL_HTTP_BASE}/cloud/api/Manager/getHistory` and pollManagerGetHistory POSTs with no request body (lib/fantasy402_settlement_ingest.ts:347-368). The response must be a JSON array or {data: []} or the poll throws (lib/fantasy402_settlement_ingest.ts:369-387). The request contract (agent scope, date window, auth) is therefore unknown, and row field shapes are not captured; tests/fixtures/fantasy402-history-poll.json is a placeholder shape sample. Surface: surface.manager-getHistory (tier D).",
      requiredCapture:
        "Capture one getHistory request/response (redacted) to record the upstream request contract (body/agent scope/date window/auth) and a real response body; this repo only proves the URL, the bodyless POST and the array-or-{data:[]} acceptance.",
      responses: {
        "200": {
          description:
            "JSON array of raw settlement rows, or an object with a data array. Any other shape throws (lib/fantasy402_settlement_ingest.ts:374-387). Row fields are not captured, so only raw/unknown objects are described.",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: true,
                      description:
                        "Raw settlement row; the poll types rows as Record<string, unknown> and no field shapes were captured.",
                    },
                  },
                  {
                    type: "object",
                    required: ["data"],
                    properties: {
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: true,
                          description:
                            "Raw settlement row; field shapes not captured.",
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        default: {
          description:
            "Non-2xx status is not captured; the poll throws on !res.ok (lib/fantasy402_settlement_ingest.ts:369-371).",
        },
      },
    },
    {
      path: "/miniapp",
      httpMethod: "GET",
      surfaceId: "surface.daemon-miniapp",
      tag: TAG_DAEMON,
      summary: "Telegram Mini App dashboard (GET /miniapp)",
      description:
        "Serves telegram-miniapp-dashboard.html as text/html (sportsdesk_webview_server.ts:144-151) with Telegram frame-ancestors CSP and no X-Frame-Options (sportsdesk_webview_server.ts:87-90). GET /miniapp/ is an alias. Surface: surface.daemon-miniapp (tier D).",
      requiredCapture:
        "HTTP capture of the served /miniapp HTML (the route is handler-verified only; no HTTP response was captured).",
      responses: {
        "200": htmlResponse(
          "Mini App dashboard HTML with the daemon CORS/CSP headers.",
          "text/html",
        ),
      },
    },
    {
      path: "/dashboard",
      httpMethod: "GET",
      surfaceId: "surface.daemon-dashboard",
      tag: TAG_DAEMON,
      summary: "Operator dashboard (GET /dashboard)",
      description:
        "Serves customer-churn-simulation-dashboard.html as text/html (sportsdesk_webview_server.ts:134-141). The same handler also answers GET /; the root path is not modelled as an OpenAPI path because the ledger has no dedicated surface row for it. Surface: surface.daemon-dashboard (tier D).",
      requiredCapture:
        "HTTP capture of the served /dashboard HTML (the route is handler-verified only; no HTTP response was captured).",
      responses: {
        "200": htmlResponse(
          "Operator dashboard HTML with the daemon CORS/CSP headers.",
          "text/html",
        ),
      },
    },
  ];
}

function surfaceOperation(
  spec: SurfaceOperationSpec,
  ledger: Ledger,
): JsonObject {
  const surface = findSurface(ledger, spec.surfaceId);
  const method = pathItemMethod(spec.httpMethod);
  const operation: JsonObject = {
    tags: [spec.tag],
    summary: spec.summary,
    description: spec.description,
    operationId: operationIdFor(method, spec.path),
    responses: spec.responses,
    "x-evidence": evidenceFromSurface(surface, spec.requiredCapture),
    "x-surface-id": surface.id,
  };
  if (spec.requestBody !== undefined) operation.requestBody = spec.requestBody;
  return operation;
}

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

function buildSecuritySchemes(): JsonObject {
  return {
    fantasy402Cookie: {
      type: "apiKey",
      in: "cookie",
      name: "session",
      description:
        "Fantasy402 Manager portal session cookie. The 2026-10-28 capture carried no Authorization header and the session is cookie-based (operational_guardrails_runbook.md:153). The capture did not record the cookie name, so 'session' is a placeholder label, not a verified cookie name.",
    },
    daemonBearer: {
      type: "http",
      scheme: "bearer",
      description:
        "Static daemon admin token: Authorization: Bearer <SPORTSDESK_ADMIN_TOKEN>, compared with crypto.timingSafeEqual (sportsdesk_webview_server.ts:27-47). The daemon answers 503 when SPORTSDESK_ADMIN_TOKEN is unset and 401 otherwise.",
    },
  };
}

function buildParameters(): JsonObject {
  return {
    XRequestedWith: {
      name: "X-Requested-With",
      in: "header",
      required: true,
      description:
        "Observed on the captured 2026-10-28 mode-B Manager request. Whether the portal enforces it is unverified.",
      schema: { type: "string", enum: ["XMLHttpRequest"] },
    },
  };
}

function buildHeaders(): JsonObject {
  return {
    CSPHeader: {
      description:
        "Content-Security-Policy applied to daemon responses: frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram: (sportsdesk_webview_server.ts:87-90).",
      schema: { type: "string" },
    },
    XContentTypeOptionsHeader: {
      description:
        "X-Content-Type-Options: nosniff (sportsdesk_webview_server.ts:89).",
      schema: { type: "string", enum: ["nosniff"] },
    },
    ReferrerPolicyHeader: {
      description:
        "Referrer-Policy: strict-origin-when-cross-origin (sportsdesk_webview_server.ts:90).",
      schema: { type: "string", enum: ["strict-origin-when-cross-origin"] },
    },
  };
}

function buildSchemas(): JsonObject {
  const catalogSource = readText(CATALOG_TYPE_SOURCE);
  const churnSource = readText(CHURN_TYPE_SOURCE);
  const catalogFixture = parseCatalogFixture(
    JSON.parse(readText(CATALOG_FIXTURE)) as unknown,
  );
  const catalogCounts = validateCatalogFixture(catalogFixture);

  const sourceToComponent: Readonly<Record<string, string>> = {
    Fantasy402SportCatalog: "Fantasy402SportCatalog",
    Fantasy402SportEntry: "SportEntry",
    Fantasy402SubSport: "SubSport",
    Fantasy402Period: "Period",
    Fantasy402CollisionEntry: "CollisionEntry",
    ExpectedEmptySubSportPaths: "ExpectedEmptySubSportPaths",
    CatalogMigrationRisk: "CatalogMigrationRisk",
    RawBetTickerTick: "RawBetTickerTick",
    RawPendingLegRow: "RawPendingLeg",
    RawWebLogEntry: "WeblogEntry",
  };
  const context: SchemaBuilderContext = {
    aliases: new Map<string, readonly string[]>([
      [
        "RawWagerTypeCode",
        parseStringUnionAlias(
          churnSource,
          "simulate_bettor_churn_suite.ts",
          "RawWagerTypeCode",
        ),
      ],
      [
        "RawTicketWriterChannel",
        parseStringUnionAlias(
          churnSource,
          "simulate_bettor_churn_suite.ts",
          "RawTicketWriterChannel",
        ),
      ],
    ]),
    componentNameFor: (sourceTypeName: string) =>
      sourceToComponent[sourceTypeName] ?? "",
  };

  const catalogTypeSpecs: readonly ComponentTypeSpec[] = [
    {
      sourceType: "Fantasy402SubSport",
      componentName: "SubSport",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description: "Sub-sport lane inside one sport (code plus display name).",
    },
    {
      sourceType: "Fantasy402Period",
      componentName: "Period",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description: "Period menu entry for one sport; period 0 is named Game.",
    },
    {
      sourceType: "Fantasy402SportEntry",
      componentName: "SportEntry",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description: "Per-sport lane: the sub-sport tree plus the period menu.",
    },
    {
      sourceType: "Fantasy402CollisionEntry",
      componentName: "CollisionEntry",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description:
        "Desk-link code shared across sports (Arena, NCAA Extra). makeDeskLinkId rewrites these to <Sport>|<code>; the collision silently breaks scoped ingestion if it is not represented.",
    },
    {
      sourceType: "ExpectedEmptySubSportPaths",
      componentName: "ExpectedEmptySubSportPaths",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description:
        "Domain-correct structural empties (sport/code paths) split into stable and volatile LIVE surfaces; not quality defects.",
    },
    {
      sourceType: "CatalogMigrationRisk",
      componentName: "CatalogMigrationRisk",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description:
        "Migration hazard note attached to catalogue entries that need coordinated link_id migration.",
    },
    {
      sourceType: "RawBetTickerTick",
      componentName: "RawBetTickerTick",
      source: churnSource,
      fileName: "simulate_bettor_churn_suite.ts",
      description:
        "Consumer wire type for one bet-ticker row. Field names and number types only; this is a type declaration, not a captured response, so the getBetTicker operation (tier C) publishes no response schema.",
    },
    {
      sourceType: "RawPendingLegRow",
      componentName: "RawPendingLeg",
      source: churnSource,
      fileName: "simulate_bettor_churn_suite.ts",
      description:
        "Consumer wire type for one pending wager leg. Risk and ToWin are cents and repeat identically across parlay legs. This is a type declaration, not a captured response; no pending-leg fixture or capture exists, so the getPending operation (tier C) publishes no response schema.",
    },
    {
      sourceType: "RawWebLogEntry",
      componentName: "WeblogEntry",
      source: churnSource,
      fileName: "simulate_bettor_churn_suite.ts",
      description:
        "Consumer type that declares the four fields the old spec published as the getWebLog response row (customerID, ipAddress, timestamp, agentOwner). It is NOT used as a response schema here: the getWebLog response body was never captured (operational_guardrails_runbook.md:153), so the row schema remains undocumented.",
    },
  ];

  const schemas: JsonObject = {
    Fantasy402SportCatalog: buildCatalogSchema(
      context,
      catalogFixture,
      catalogCounts,
    ),
  };
  for (const spec of catalogTypeSpecs) {
    schemas[spec.componentName] = buildSchemaFromType(spec, context);
  }
  return schemas;
}

/* -------------------------------------------------------------------------- */
/* Spec assembly                                                              */
/* -------------------------------------------------------------------------- */

function buildInfo(): JsonObject {
  return {
    title: "SportsDesk & Fantasy402 Wire API (evidence-labelled)",
    version: "2026.10.31",
    description:
      "Evidence model: every operation carries x-evidence.tier — A means a captured request and response are verified, B means observed first-party evidence (a captured request or a handler-verified route) without a captured response, C means inferred only with no capture, and D means a real surface missing from the spec; this release has no tier-A rows because no response body was ever captured (see docs/EVIDENCE.md).",
  };
}

function buildServers(): readonly JsonObject[] {
  return [
    {
      url: "https://www.fantasy402.com",
      description:
        "Fantasy402 cloud portal (Manager/Report/System API). Request-side evidence only; no response body was captured.",
    },
    {
      url: "http://127.0.0.1:4020",
      description:
        "SportsDesk local daemon (Bun.serve; binds 0.0.0.0 by default, PORT=4020).",
    },
  ];
}

function buildTags(): readonly JsonObject[] {
  return [
    {
      name: TAG_FORENSIC,
      description:
        "Cloud Manager surveillance operations with first-party evidence (request capture only; no response body captured).",
    },
    {
      name: TAG_CUSTOMER,
      description:
        "Cloud Manager customer state operations with first-party evidence (request capture only; no response body captured).",
    },
    {
      name: TAG_DAEMON,
      description:
        "Routes served by sportsdesk_webview_server.ts, verified against the handler source rather than an HTTP capture.",
    },
    {
      name: TAG_SETTLEMENT,
      description:
        "Upstream settlement-history poll wired in code; the request contract and response rows are uncaptured.",
    },
    {
      name: TAG_INFERRED,
      description:
        "Tier C operations: inferred or authored only. No request or response was ever observed; path and method are candidates, not contracts.",
    },
  ];
}

function buildPaths(ledger: Ledger): JsonObject {
  const paths: JsonObject = {};
  for (const operation of ledger.operations) {
    if (operation.tier === "E") continue;
    if (operation.path.includes("manager-tools/ajax.php")) continue;
    const method = operation.method;
    if (!isHttpMethod(method)) {
      fail(`ledger row ${operation.path} has unsupported method "${method}"`);
    }
    const pathItem = paths[operation.path];
    const builder: JsonObject =
      pathItem !== undefined && isRecord(pathItem) ? pathItem : {};
    if (operation.tier === "B") {
      const operationBuilder = B_OPERATION_BUILDERS[operation.path];
      if (operationBuilder === undefined) {
        fail(
          `tier B ledger row ${operation.path} has no evidenced operation builder`,
        );
      }
      builder[method] = operationBuilder(operation);
    } else if (operation.tier === "C") {
      const summary =
        SUMMARIES[operation.path] ??
        `${operation.method.toUpperCase()} ${operation.path}`;
      builder[method] = inferredOperation(operation, summary);
    } else {
      fail(`unexpected ledger tier "${operation.tier}" for ${operation.path}`);
    }
    paths[operation.path] = builder;
  }
  for (const spec of surfaceOperationSpecs(ledger)) {
    const existing = paths[spec.path];
    const pathItem: JsonObject =
      existing !== undefined && isRecord(existing) ? existing : {};
    pathItem[pathItemMethod(spec.httpMethod)] = surfaceOperation(spec, ledger);
    paths[spec.path] = pathItem;
  }
  return paths;
}

function buildSpec(ledger: Ledger): JsonObject {
  return {
    openapi: "3.1.0",
    info: buildInfo(),
    servers: buildServers(),
    tags: buildTags(),
    paths: buildPaths(ledger),
    components: {
      securitySchemes: buildSecuritySchemes(),
      parameters: buildParameters(),
      headers: buildHeaders(),
      schemas: buildSchemas(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Self-gating + output                                                       */
/* -------------------------------------------------------------------------- */

function collectOperationsFromPaths(
  paths: JsonObject,
): { path: string; method: string; operation: JsonObject }[] {
  const operations: { path: string; method: string; operation: JsonObject }[] =
    [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isHttpMethod(method) || !isRecord(operation)) continue;
      operations.push({ path, method, operation });
    }
  }
  return operations;
}

function tierCounts(operations: readonly { operation: JsonObject }[]): {
  readonly A: number;
  readonly B: number;
  readonly C: number;
  readonly D: number;
} {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const entry of operations) {
    const evidence = entry.operation["x-evidence"];
    const tier = isRecord(evidence) ? evidence.tier : undefined;
    if (tier === "A" || tier === "B" || tier === "C" || tier === "D") {
      counts[tier] += 1;
    }
  }
  return counts;
}

function reportOutcome(outcome: CheckOutcome): void {
  for (const note of outcome.notes) {
    console.log(`  note: ${note}`);
  }
  for (const issue of outcome.issues) {
    console.error(`  - [${issue.code}] ${issue.message}`);
  }
}

function selfGate(
  spec: JsonObject,
  ledger: Ledger,
  rawLedger: unknown,
  rawText: string,
): void {
  const outcomes: readonly CheckOutcome[] = [
    checkOpenApi(spec, rawText),
    checkLedger(rawLedger, spec),
  ];
  let failed = false;
  for (const outcome of outcomes) {
    if (outcome.status === "fail") {
      failed = true;
      console.error(`generate_openapi: gate failed: ${outcome.name}`);
      reportOutcome(outcome);
    }
  }
  if (failed) fail("generated spec does not pass scripts/verify_docs.ts");

  const paths = spec.paths;
  if (!isRecord(paths)) fail("internal: paths missing");
  const operations = collectOperationsFromPaths(paths);
  if (operations.length !== EXPECTED_SPEC_OPERATIONS) {
    fail(
      `expected ${EXPECTED_SPEC_OPERATIONS} operations, generated ${operations.length}`,
    );
  }
  const tiers = tierCounts(operations);
  for (const tier of ["A", "B", "C", "D"] as const) {
    const expected = EXPECTED_SPEC_TIERS[tier];
    if (tiers[tier] !== expected) {
      fail(
        `expected ${expected} tier-${tier} operations, found ${tiers[tier]}`,
      );
    }
  }

  const usedTags = new Set<string>();
  for (const entry of operations) {
    const tags = entry.operation.tags;
    if (Array.isArray(tags)) {
      for (const tag of tags) if (typeof tag === "string") usedTags.add(tag);
    }
  }
  for (const tag of USED_TAGS) {
    if (!usedTags.has(tag))
      fail(`declared tag "${tag}" is unused by any operation`);
  }
  for (const tag of usedTags) {
    if (!(USED_TAGS as readonly string[]).includes(tag)) {
      fail(`operation uses undeclared tag "${tag}"`);
    }
  }

  if (rawText.includes("ajax.php")) {
    fail("generated spec must not mention ajax.php");
  }
  if (rawText.includes("sportswidgets.pro")) {
    fail("generated spec must not mention sportswidgets.pro");
  }
  const credentialPatterns: readonly RegExp[] = [
    /Bearer\s+eyJ[A-Za-z0-9_-]+/,
    /DESK-[A-Za-z0-9]{6,}/,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  ];
  for (const pattern of credentialPatterns) {
    if (pattern.test(rawText)) {
      fail(
        `generated spec still contains a credential-shaped example (${pattern})`,
      );
    }
  }

  const evidenceMd = readText(EVIDENCE_MD_PATH);
  for (const entry of operations) {
    const surfaceId = entry.operation["x-surface-id"];
    if (typeof surfaceId !== "string") continue;
    if (!evidenceMd.includes(surfaceId)) {
      fail(
        `surface id "${surfaceId}" does not appear verbatim in docs/EVIDENCE.md`,
      );
    }
  }
  const servers = spec.servers;
  if (!Array.isArray(servers) || servers.length !== 2) {
    fail("the spec must declare exactly two servers");
  }
}

/**
 * Reformat a written artifact with the repository's pinned bun formatter.
 *
 * The committed docs/openapi.json must equal BOTH the generator output and the
 * formatter output: CI's repo-wide `bun run format:check` formats JSON arrays
 * differently from JSON.stringify, and the freshness gate byte-diffs the
 * generated temp file against the committed one. Running the formatter on every
 * output (in place or `--out`) keeps both constraints satisfied.
 *
 * `cwd: ROOT` makes bun resolve the same bunfig.toml formatter settings for an
 * `--out` temp path as it does for docs/openapi.json.
 */
function formatWithRepoFormatter(outputPath: string): void {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "fmt", outputPath],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    fail(
      `bun fmt failed for ${outputPath} (exit ${String(result.exitCode)}): ${stderr || stdout || "no output"}`,
    );
  }
}

function parseOutputPath(argv: readonly string[]): string {
  let output = DEFAULT_OUTPUT_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      const next = argv[index + 1];
      if (next === undefined) fail("--out requires a path");
      output = resolve(process.cwd(), next);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log("usage: bun run scripts/generate_openapi.ts [--out <path>]");
      process.exitCode = 0;
      return "";
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return output;
}

function main(argv: readonly string[]): void {
  const outputPath = parseOutputPath(argv);
  if (outputPath === "") return;
  const rawLedger = JSON.parse(readText(LEDGER_PATH)) as unknown;
  const ledger = parseLedger(rawLedger);
  assertFrozenLedger(ledger);
  const spec = buildSpec(ledger);
  const rawText = `${JSON.stringify(spec, null, 2)}\n`;
  selfGate(spec, ledger, rawLedger, rawText);

  const paths = spec.paths;
  if (!isRecord(paths)) fail("internal: paths missing");
  const operationCount = collectOperationsFromPaths(paths).length;
  const tiers = tierCounts(collectOperationsFromPaths(paths));

  writeFileSync(outputPath, rawText, "utf8");
  formatWithRepoFormatter(outputPath);
  const formattedText = readText(outputPath);
  JSON.parse(formattedText);
  const digest = createHash("sha256").update(formattedText).digest("hex");
  const relative = outputPath.startsWith(ROOT)
    ? outputPath.slice(ROOT.length + 1)
    : outputPath;
  console.log(
    `generate_openapi: wrote ${relative} — ${Object.keys(paths).length} paths / ${operationCount} operations (A${String(tiers.A)} B${String(tiers.B)} C${String(tiers.C)} D${String(tiers.D)}), sha256 ${digest}`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : `generate_openapi: ${String(error)}`,
    );
    process.exitCode = 1;
  }
}
