/**
 * List-agents XHR path fragments (wire typo + DevTools/network label variants).
 * POST `operation` remains `getListAgenstByAgent` in manager.js; URL path may differ in UI.
 */

/** Canonical operation field on form body (manager.js). */
export const LIST_AGENTS_OPERATION = "getListAgenstByAgent" as const;

/** Path suffixes observed on live captures (match any). */
export const LIST_AGENTS_URL_PATH_FRAGMENTS = [
  "getListAgenstByAgent",
  "getListAgentByAgent",
] as const;

export function urlPathLooksLikeListAgents(url: string): boolean {
  return LIST_AGENTS_URL_PATH_FRAGMENTS.some((frag) => url.includes(frag));
}
