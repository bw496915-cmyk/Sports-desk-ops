/**
 * Strict top-level shape for `getListAgenstByAgent` JSON (fail-loud vs silent empty parse).
 */

export const LIST_AGENTS_ENVELOPE_KEYS = [
  "GENERAL",
  "PLAYERS",
  "EXTRA",
] as const;

export type ListAgentsEnvelopeKey = (typeof LIST_AGENTS_ENVELOPE_KEYS)[number];

export function assertListAgentsTopLevelKeys(
  raw: unknown,
): asserts raw is Record<ListAgentsEnvelopeKey, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      "getListAgenstByAgent response must be a JSON object (not empty HTML or error wrapper)",
    );
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expected = [...LIST_AGENTS_ENVELOPE_KEYS].sort();
  if (keys.length !== expected.length) {
    throw new Error(
      `envelope top-level keys must be exactly {GENERAL, PLAYERS, EXTRA}; got keys=[${keys.join(", ")}]`,
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) {
      throw new Error(
        `envelope top-level keys must be exactly {GENERAL, PLAYERS, EXTRA}; got keys=[${keys.join(", ")}]`,
      );
    }
  }
}
