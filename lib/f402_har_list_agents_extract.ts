/**
 * Extract list-agents JSON from a redacted manager-boot HAR (parse at HAR boundary).
 */

import { LIST_AGENTS_ENVELOPE_KEYS } from "./f402_list_agents_envelope_strict.ts";
import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";
import { postDataDeclaresListAgentsOperation } from "./f402_hierarchy_list_agents_operation.ts";
import { urlPathLooksLikeListAgents } from "./f402_list_agents_url_match.ts";
import { parseListAgentsByAgentWireText } from "./f402_list_agents_wire_boundary.ts";

/** @deprecated Prefer {@link urlPathLooksLikeListAgents}. */
export const LIST_AGENTS_HAR_URL_FRAGMENT = "getListAgenstByAgent";

export interface HarListAgentsCandidate {
  readonly url: string;
  readonly bodyText: string;
  readonly status: number;
  readonly hasOperationField: boolean;
}

function responseStatus(entry: Record<string, unknown>): number {
  const response = entry.response;
  if (typeof response !== "object" || response === null) return 0;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" ? status : Number(status) || 0;
}

function requestPostData(entry: Record<string, unknown>): unknown {
  const request = entry.request;
  if (typeof request !== "object" || request === null) return undefined;
  return (request as { postData?: unknown }).postData;
}

function requestMethod(entry: Record<string, unknown>): string {
  const request = entry.request;
  if (typeof request !== "object" || request === null) return "";
  const method = (request as { method?: string }).method;
  return typeof method === "string" ? method.toUpperCase() : "";
}

function hasStrictEnvelopeKeys(bodyText: string): boolean {
  const trimmed = bodyText.trim();
  if (trimmed === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const keys = Object.keys(parsed as Record<string, unknown>).sort();
  const expected = [...LIST_AGENTS_ENVELOPE_KEYS].sort();
  if (keys.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) return false;
  }
  return true;
}

export function listListAgentsCandidatesFromHar(
  harRoot: unknown,
): readonly HarListAgentsCandidate[] {
  if (typeof harRoot !== "object" || harRoot === null) {
    throw new Error("HAR root must be a JSON object");
  }
  const log = (harRoot as { log?: unknown }).log;
  if (typeof log !== "object" || log === null) {
    throw new Error("HAR missing log object");
  }
  const entries = (log as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error("HAR log.entries must be an array");
  }

  const hits: HarListAgentsCandidate[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const request = obj.request;
    if (typeof request !== "object" || request === null) continue;
    const url = (request as { url?: string }).url ?? "";
    if (!urlPathLooksLikeListAgents(url)) continue;
    if (requestMethod(obj) !== "POST") continue;

    const postData = requestPostData(obj);
    const hasOperationField = postDataDeclaresListAgentsOperation(postData);
    if (!hasOperationField) continue;

    const status = responseStatus(obj);
    if (status !== 200) continue;

    const content = (obj.response as { content?: { text?: string } } | undefined)
      ?.content;
    const bodyText = content?.text;
    if (typeof bodyText !== "string" || bodyText.trim() === "") continue;
    if (!hasStrictEnvelopeKeys(bodyText)) continue;

    hits.push({ url, bodyText, status, hasOperationField });
  }
  return hits;
}

/** Last qualifying list-agents response (boot retries; final tree wins). */
export function pickListAgentsEnvelopeFromHar(
  harRoot: unknown,
): { readonly envelope: ListAgentsByAgentEnvelope; readonly url: string } {
  const hits = listListAgentsCandidatesFromHar(harRoot);
  if (hits.length === 0) {
    throw new Error(
      "HAR has no qualifying list-agents entry (POST operation=getListAgenstByAgent, status 200, strict envelope, non-empty body)",
    );
  }
  const last = hits[hits.length - 1]!;
  return {
    url: last.url,
    envelope: parseListAgentsByAgentWireText(last.bodyText),
  };
}

/** @deprecated Prefer {@link listListAgentsCandidatesFromHar}. */
export function listListAgentsResponseBodiesFromHar(
  harRoot: unknown,
): readonly { readonly url: string; readonly bodyText: string }[] {
  return listListAgentsCandidatesFromHar(harRoot).map((h) => ({
    url: h.url,
    bodyText: h.bodyText,
  }));
}
