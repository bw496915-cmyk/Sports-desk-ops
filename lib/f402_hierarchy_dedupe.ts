import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";

let lastEnvelope: ListAgentsByAgentEnvelope | null = null;

/** Strict deep compare vs previous envelope (boot dedupe / drift hint). */
export function isDuplicateEnvelope(next: ListAgentsByAgentEnvelope): boolean {
  const same =
    lastEnvelope !== null && Bun.deepEquals(lastEnvelope, next, true);
  lastEnvelope = next;
  return same;
}

export function resetEnvelopeDedupe(): void {
  lastEnvelope = null;
}
