import { describe, expect, test } from "bun:test";

import { LIST_AGENTS_OPERATION } from "./f402_hierarchy_list_agents_operation.ts";
import {
  listListAgentsCandidatesFromHar,
  pickListAgentsEnvelopeFromHar,
} from "./f402_har_list_agents_extract.ts";

function harEntry(options: {
  url?: string;
  status?: number;
  operation?: string;
  body?: unknown;
  method?: string;
  omitPostData?: boolean;
}) {
  const url =
    options.url ??
    "https://www.fantasy402.com/cloud/api/Manager/getListAgenstByAgent";
  const operation = options.operation ?? LIST_AGENTS_OPERATION;
  return {
    request: {
      method: options.method ?? "POST",
      url,
      ...(options.omitPostData
        ? {}
        : {
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              text: `operation=${operation}&RRO=1&agentID=X&agentType=M`,
            },
          }),
    },
    response: {
      status: options.status ?? 200,
      content: {
        text: JSON.stringify(
          options.body ?? { GENERAL: [{ Level: 1 }], PLAYERS: [], EXTRA: true },
        ),
      },
    },
  };
}

describe("listListAgentsCandidatesFromHar", () => {
  test("uses last qualifying entry only", () => {
    const har = {
      log: {
        entries: [
          harEntry({
            body: { GENERAL: [{ Level: 1 }], PLAYERS: [], EXTRA: false },
          }),
          harEntry({
            body: { GENERAL: [{ Level: 2 }], PLAYERS: [], EXTRA: true },
          }),
        ],
      },
    };
    const { envelope } = pickListAgentsEnvelopeFromHar(har);
    expect(envelope.GENERAL[0]?.Level).toBe(2);
  });

  test("skips non-200 and wrong operation", () => {
    const har = {
      log: {
        entries: [
          harEntry({ status: 401 }),
          harEntry({ operation: "otherOp" }),
          harEntry({ omitPostData: true }),
          harEntry({ body: { GENERAL: [], PLAYERS: [], EXTRA: true } }),
        ],
      },
    };
    const hits = listListAgentsCandidatesFromHar(har);
    expect(hits).toHaveLength(1);
  });
});
