import {
  LIST_AGENTS_OPERATION,
  urlPathLooksLikeListAgents,
} from "./f402_list_agents_url_match.ts";

export { LIST_AGENTS_OPERATION, urlPathLooksLikeListAgents };

export function postDataDeclaresListAgentsOperation(
  postData: unknown,
): boolean {
  if (postData === undefined || postData === null) return false;
  if (typeof postData === "string") {
    const params = new URLSearchParams(postData);
    return params.get("operation") === LIST_AGENTS_OPERATION;
  }
  if (typeof postData === "object") {
    const text = (postData as { text?: string }).text;
    if (typeof text === "string" && text !== "") {
      return postDataDeclaresListAgentsOperation(text);
    }
    const params = (
      postData as { params?: readonly { name?: string; value?: string }[] }
    ).params;
    if (Array.isArray(params)) {
      for (const p of params) {
        if (p.name === "operation" && p.value === LIST_AGENTS_OPERATION)
          return true;
      }
    }
  }
  return false;
}
