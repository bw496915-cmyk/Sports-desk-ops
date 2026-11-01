/**
 * Compare portal oracle output when only GENERAL AgentID / Login labels change.
 */

import {
  trimPaddedField,
  type ListAgentsByAgentGeneralWireRow,
} from "./f402_list_agents_by_agent.ts";
import {
  normalizeNested,
  oracleSnapshot,
  runPortalHierarchyOracle,
  type PortalGeneralRow,
} from "./f402_portal_hierarchy_oracle.ts";

export function collectGeneralLabelVariants(
  original: readonly ListAgentsByAgentGeneralWireRow[],
  placeholder: readonly ListAgentsByAgentGeneralWireRow[],
): readonly string[] {
  if (original.length !== placeholder.length) {
    throw new Error("label map requires same GENERAL length");
  }
  const labels = new Set<string>();
  for (let i = 0; i < original.length; i += 1) {
    const a = original[i];
    const b = placeholder[i];
    if (a === undefined || b === undefined) continue;
    for (const field of ["AgentID", "Login"] as const) {
      for (const raw of [a[field], b[field]]) {
        if (typeof raw !== "string" || raw === "") continue;
        labels.add(raw);
        const trimmed = trimPaddedField(raw);
        if (trimmed !== "") labels.add(trimmed);
      }
    }
  }
  return [...labels].sort((x, y) => y.length - x.length);
}

export function relabelOracleValue(
  value: unknown,
  labels: readonly string[],
  canonical: string,
): unknown {
  if (typeof value === "string") {
    if (labels.includes(value)) return canonical;
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => relabelOracleValue(item, labels, canonical));
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const nextKey = labels.includes(key) ? canonical : key;
    out[nextKey] = relabelOracleValue(val, labels, canonical);
  }
  return out;
}

export function oracleSnapshotLabelAgnostic(
  nested: unknown,
  labels: readonly string[],
): string {
  const canonical = "__AGENT_LABEL__";
  const normalized = relabelOracleValue(normalizeNested(nested), labels, canonical);
  return oracleSnapshot(normalized);
}

export async function assertOracleEquivalentAfterGeneralPlaceholder(
  original: readonly ListAgentsByAgentGeneralWireRow[],
  placeholder: readonly ListAgentsByAgentGeneralWireRow[],
): Promise<void> {
  const labels = collectGeneralLabelVariants(original, placeholder);
  const [fromOriginal, fromPlaceholder] = await Promise.all([
    runPortalHierarchyOracle(original as PortalGeneralRow[], {
      runSetComplete: true,
    }),
    runPortalHierarchyOracle(placeholder as PortalGeneralRow[], {
      runSetComplete: true,
    }),
  ]);
  const snapA = oracleSnapshotLabelAgnostic(fromOriginal.nested, labels);
  const snapB = oracleSnapshotLabelAgnostic(fromPlaceholder.nested, labels);
  if (snapA !== snapB) {
    throw new Error(
      "oracle nested snapshot differs after label-agnostic normalization (placeholder pass changed tree semantics)",
    );
  }
}
