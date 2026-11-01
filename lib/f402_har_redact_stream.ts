/**
 * Redact HAR / JSON capture text before disk write (never persist raw response bodies with secrets).
 */

import { assertRedactedCaptureSweep } from "./f402_har_redaction_sweep.ts";
import { PRODUCTION_PASSWORD_SENTINEL } from "./f402_production_fixture_redaction.ts";

const FORBIDDEN = [
  /\bset-cookie\b/gi,
  /\bauthorization\b/gi,
  /\bBearer\s+[A-Za-z0-9._-]+/g,
];

export function redactHarJsonText(raw: string): string {
  let out = raw;
  out = out.replace(
    /"Password"\s*:\s*"[^"]*"/g,
    `"Password":"${PRODUCTION_PASSWORD_SENTINEL}"`,
  );
  out = out.replace(/"NameFirst"\s*:\s*"[^"]*"/g, '"NameFirst":"[REDACTED]"');
  out = out.replace(/"cookie"\s*:\s*"[^"]*"/gi, '"cookie":"[REDACTED]"');
  for (const re of FORBIDDEN) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export interface RedactedHarWriteResult {
  readonly redactedText: string;
  readonly bytes: number;
}

/** Redact in memory; run sentinel sweep; then caller writes (or use writeRedactedHarFile). */
export function prepareRedactedHarText(
  harObject: unknown,
): RedactedHarWriteResult {
  const raw = `${JSON.stringify(harObject, null, 2)}\n`;
  const redactedText = redactHarJsonText(raw);
  assertRedactedCaptureSweep(redactedText);
  return { redactedText, bytes: redactedText.length };
}

export async function writeRedactedHarFile(
  path: string,
  harObject: unknown,
): Promise<RedactedHarWriteResult> {
  const prepared = prepareRedactedHarText(harObject);
  await Bun.write(path, prepared.redactedText);
  return prepared;
}
