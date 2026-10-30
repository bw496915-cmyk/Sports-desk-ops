/**
 * Plane 3 — verify ingestion JSONL `xml_golden_ast_sha256` pins (mirror dotfiles replay module).
 */

import { goldenAstFingerprintFromXml } from "./bun_xml_golden_ast.ts";

export const XML_GOLDEN_AST_REPLAY_DRIFT_EXIT = 4 as const;

export type IngestionXmlGoldenAstReplayStats = {
  rowsWithXml: number;
  rowsWithPin: number;
  verified: number;
  drift: number;
  missingPin: number;
  missingXml: number;
  bunVersionMismatch: number;
};

export function emptyIngestionXmlGoldenAstReplayStats(): IngestionXmlGoldenAstReplayStats {
  return {
    rowsWithXml: 0,
    rowsWithPin: 0,
    verified: 0,
    drift: 0,
    missingPin: 0,
    missingXml: 0,
    bunVersionMismatch: 0,
  };
}

export type IngestionXmlGoldenVerifyOptions = {
  expectedBunVersion?: string;
  /** When true, rows with `xml` but no pin count as missingPin. */
  strictPins?: boolean;
};

function readStringField(
  row: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = row[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Verify one JSONL object (pre-parse). Returns null when row has no xml/pin fields. */
export function verifyIngestionJsonlXmlGoldenAst(
  value: unknown,
  options: IngestionXmlGoldenVerifyOptions = {},
):
  | { ok: true }
  | {
      ok: false;
      reason: "drift" | "missingPin" | "missingXml" | "bunVersionMismatch";
    }
  | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const xml = readStringField(row, "xml");
  const pin = readStringField(row, "xml_golden_ast_sha256");
  const bunVersion = readStringField(row, "bun_version");

  if (!xml && !pin) return null;

  if (options.strictPins && xml && !pin) {
    return { ok: false, reason: "missingPin" };
  }
  if (pin && !xml) {
    return { ok: false, reason: "missingXml" };
  }
  if (xml && pin) {
    const live = goldenAstFingerprintFromXml(xml);
    if (live.sha256 !== pin) {
      return { ok: false, reason: "drift" };
    }
    if (
      options.expectedBunVersion &&
      bunVersion &&
      bunVersion !== options.expectedBunVersion
    ) {
      return { ok: false, reason: "bunVersionMismatch" };
    }
    return { ok: true };
  }
  return null;
}

export function applyIngestionXmlGoldenVerdict(
  verdict: NonNullable<ReturnType<typeof verifyIngestionJsonlXmlGoldenAst>>,
  stats: IngestionXmlGoldenAstReplayStats,
  hadXml: boolean,
  hadPin: boolean,
): void {
  if (hadXml) stats.rowsWithXml += 1;
  if (hadPin) stats.rowsWithPin += 1;
  if (verdict === null) return;
  if (verdict.ok) {
    stats.verified += 1;
    return;
  }
  const reason = verdict.reason;
  if (reason === "drift") stats.drift += 1;
  else if (reason === "missingPin") stats.missingPin += 1;
  else if (reason === "missingXml") stats.missingXml += 1;
  else if (reason === "bunVersionMismatch") stats.bunVersionMismatch += 1;
}

export function accumulateIngestionJsonlXmlGoldenAst(
  value: unknown,
  stats: IngestionXmlGoldenAstReplayStats,
  options: IngestionXmlGoldenVerifyOptions = {},
): void {
  if (typeof value !== "object" || value === null) return;
  const row = value as Record<string, unknown>;
  const xml = readStringField(row, "xml");
  const pin = readStringField(row, "xml_golden_ast_sha256");
  const verdict = verifyIngestionJsonlXmlGoldenAst(value, options);
  if (verdict === null && !options.strictPins) return;
  if (verdict === null && options.strictPins && xml) {
    applyIngestionXmlGoldenVerdict(
      { ok: false, reason: "missingPin" },
      stats,
      Boolean(xml),
      Boolean(pin),
    );
    return;
  }
  if (verdict !== null) {
    applyIngestionXmlGoldenVerdict(
      verdict,
      stats,
      Boolean(xml),
      Boolean(pin),
    );
  }
}

export function exitCodeFromIngestionXmlGoldenAstStats(
  stats: IngestionXmlGoldenAstReplayStats,
): 0 | typeof XML_GOLDEN_AST_REPLAY_DRIFT_EXIT {
  if (
    stats.drift > 0 ||
    stats.missingPin > 0 ||
    stats.missingXml > 0 ||
    stats.bunVersionMismatch > 0
  ) {
    return XML_GOLDEN_AST_REPLAY_DRIFT_EXIT;
  }
  return 0;
}

/** Plane 1 writer helper — attach pins before append. */
export function enrichIngestionJsonlRowWithXmlGoldenAst<
  T extends { xml: string },
>(row: T, bunVersion = Bun.version): T & {
  xml_golden_ast_sha256: string;
  bun_version: string;
} {
  return {
    ...row,
    xml_golden_ast_sha256: goldenAstFingerprintFromXml(row.xml).sha256,
    bun_version: bunVersion,
  };
}
