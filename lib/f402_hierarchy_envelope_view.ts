import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";
import { redactUnknown } from "./f402_hierarchy_redact.ts";

/**
 * Safe console / `Bun.inspect` view of a hierarchy envelope (passwords redacted).
 */
export class HierarchyEnvelopeView {
  constructor(readonly raw: ListAgentsByAgentEnvelope) {}

  toSafeString(): string {
    return Bun.inspect(redactUnknown(this.raw));
  }

  [Bun.inspect.custom](): string {
    return this.toSafeString();
  }
}
