/**
 * @file lib/agent_downline.ts
 * @description Agent rollups from the downline snapshot and direct/descendant counts from the tree.
 *
 * The downline snapshot is a point-in-time fixture (`sportsdesk_downline_data.json`), not a live
 * feed; the artifact labels it as such. Missing agents stay absent, never zero.
 */

import { readFile } from "node:fs/promises";

export interface AgentDownlineRollup {
  readonly agent: string;
  readonly master: string | null;
  readonly totalAccounts: number | null;
  readonly activeSportsAccounts: number | null;
  readonly dormantAccounts: number | null;
  readonly lifetimeLostUsd: number | null;
  readonly lifetimeWonUsd: number | null;
  readonly lifetimeNetUsd: number | null;
  readonly sportsTickets: number | null;
  readonly sportsVolumeUsd: number | null;
  readonly sportsNetUsd: number | null;
  readonly holdPct: number | null;
  readonly toxicity: number | null;
  readonly sharpCount: number | null;
  readonly grade: string | null;
  readonly agentType: string | null;
}

export interface TreeDownlineCounts {
  readonly directAgents: number;
  readonly descendantAgents: number;
}

export interface AgentDownlineIndex {
  readonly source: string;
  readonly agents: number;
  readonly byAgent: ReadonlyMap<string, AgentDownlineRollup>;
  readonly meta: Record<string, unknown> | null;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

export async function loadAgentDownline(
  path: string,
): Promise<AgentDownlineIndex | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;
  const rows = Array.isArray(doc.agents) ? doc.agents : [];
  const byAgent = new Map<string, AgentDownlineRollup>();
  for (const value of rows) {
    if (value === null || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const agent = str(row.agent)?.toUpperCase() ?? null;
    if (agent === null) continue;
    byAgent.set(agent, {
      agent,
      master: str(row.master),
      totalAccounts: num(row.total_accounts),
      activeSportsAccounts: num(row.active_sports_accounts),
      dormantAccounts: num(row.dormant_accounts),
      lifetimeLostUsd: num(row.lifetime_lost),
      lifetimeWonUsd: num(row.lifetime_won),
      lifetimeNetUsd: num(row.lifetime_net),
      sportsTickets: num(row.sports_tickets),
      sportsVolumeUsd: num(row.sports_vol),
      sportsNetUsd: num(row.sports_net),
      holdPct: num(row.hold_pct),
      toxicity: num(row.toxicity),
      sharpCount: num(row.sharp_count),
      grade: str(row.grade),
      agentType: str(row.agent_type),
    });
  }
  if (byAgent.size === 0) return null;
  return {
    source: path,
    agents: byAgent.size,
    byAgent,
    meta:
      doc.meta !== null && typeof doc.meta === "object"
        ? (doc.meta as Record<string, unknown>)
        : null,
  };
}

/** Direct children and all descendants per agent, from the tree's parent links. */
export function treeDownlineCounts(
  nodes: Readonly<Record<string, { readonly p?: string | null | undefined }>>,
  agentIds: Iterable<string>,
): ReadonlyMap<string, TreeDownlineCounts> {
  const children = new Map<string, string[]>();
  for (const [id, node] of Object.entries(nodes)) {
    const parent =
      typeof node.p === "string" ? node.p.trim().toUpperCase() : "";
    if (parent === "") continue;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [id.toUpperCase()]);
    else list.push(id.toUpperCase());
  }
  const counts = new Map<string, TreeDownlineCounts>();
  for (const raw of agentIds) {
    const id = raw.trim().toUpperCase();
    if (id === "" || counts.has(id)) continue;
    const direct = children.get(id) ?? [];
    const seen = new Set<string>([id]);
    const queue = [...direct];
    let descendants = 0;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      descendants++;
      queue.push(...(children.get(next) ?? []));
    }
    counts.set(id, {
      directAgents: direct.length,
      descendantAgents: descendants,
    });
  }
  return counts;
}

export interface AgentExposure {
  readonly customers: number;
  readonly positions: number;
  readonly openRiskUsd: number;
  readonly openToWinUsd: number;
}

/**
 * Open-position exposure per agent subtree, from the tree's parent links. A customer counts once
 * toward its own agent and every ancestor, so an agent's entry is the whole downline below it;
 * agents outside the tree still get their own direct exposure.
 */
export function treeSubtreeExposure(
  nodes: Readonly<Record<string, { readonly p?: string | null | undefined }>>,
  profiles: Iterable<{
    readonly agentId: string;
    readonly positions: readonly {
      readonly risk_usd?: number | undefined;
      readonly to_win_usd?: number | undefined;
    }[];
  }>,
): ReadonlyMap<string, AgentExposure> {
  const parent = new Map<string, string>();
  for (const [id, node] of Object.entries(nodes)) {
    const key = id.trim().toUpperCase();
    const up = typeof node.p === "string" ? node.p.trim().toUpperCase() : "";
    if (key !== "" && up !== "") parent.set(key, up);
  }
  const exposure = new Map<string, AgentExposure>();
  const add = (agent: string, value: AgentExposure): void => {
    const current = exposure.get(agent);
    exposure.set(agent, {
      customers: (current?.customers ?? 0) + value.customers,
      positions: (current?.positions ?? 0) + value.positions,
      openRiskUsd: (current?.openRiskUsd ?? 0) + value.openRiskUsd,
      openToWinUsd: (current?.openToWinUsd ?? 0) + value.openToWinUsd,
    });
  };
  for (const profile of profiles) {
    const agent = profile.agentId.trim().toUpperCase();
    if (agent === "") continue;
    const risk = profile.positions.reduce(
      (total, position) => total + (position.risk_usd ?? 0),
      0,
    );
    const toWin = profile.positions.reduce(
      (total, position) => total + (position.to_win_usd ?? 0),
      0,
    );
    const value: AgentExposure = {
      customers: 1,
      positions: profile.positions.length,
      openRiskUsd: risk,
      openToWinUsd: toWin,
    };
    const seen = new Set<string>();
    let current = agent;
    while (current !== "" && !seen.has(current)) {
      seen.add(current);
      add(current, value);
      current = parent.get(current) ?? "";
    }
  }
  return exposure;
}
