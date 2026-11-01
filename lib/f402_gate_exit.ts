/**
 * Gate exit codes: BLOCKED (waiting on artifact) vs FAILED (broken tool / bad data).
 */

export const GATE_EXIT_OK = 0;
export const GATE_EXIT_FAILED = 1;
/** Waiting on capture, fixture, or variance index — not a regression. */
export const GATE_EXIT_BLOCKED = 10;

export function emitGateBlocked(
  signal: string,
  payload: Record<string, unknown>,
): never {
  console.error(JSON.stringify({ signal, gateOutcome: "BLOCKED", ...payload }));
  process.exit(GATE_EXIT_BLOCKED);
}

export function emitGateFailed(
  signal: string,
  payload: Record<string, unknown>,
): never {
  console.error(JSON.stringify({ signal, gateOutcome: "FAILED", ...payload }));
  process.exit(GATE_EXIT_FAILED);
}
