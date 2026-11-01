import { estimateShallowMemoryUsageOf } from "bun:jsc";

import type { ListAgentsByAgentPlayerWireRow } from "./f402_list_agents_by_agent.ts";

/** Rough PLAYERS heap argument (sample one row; arrays are not contiguous). */
export function estimatePlayersShallowBytes(
  players: readonly ListAgentsByAgentPlayerWireRow[],
): { perRow: number; estimatedTotal: number; sampleSize: number } | null {
  if (players.length === 0)
    return { perRow: 0, estimatedTotal: 0, sampleSize: 0 };
  const sample = players[0];
  if (sample === undefined) return null;
  const perRow = estimateShallowMemoryUsageOf(sample);
  return {
    perRow,
    estimatedTotal: perRow * players.length,
    sampleSize: players.length,
  };
}
