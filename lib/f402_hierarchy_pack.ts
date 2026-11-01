import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";

/** Async zstd pack for at-rest capture (see Bun Utils — `Bun.zstdCompress`). */
export async function packCaptureEnvelope(
  envelope: ListAgentsByAgentEnvelope,
  level = 6,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  return Bun.zstdCompress(bytes, { level });
}
