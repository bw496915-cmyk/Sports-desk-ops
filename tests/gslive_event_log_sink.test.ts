/**
 * @file gslive_event_log_sink.test.ts
 * @description Validates the key scheme, metadata and index behaviour of the GSLive event-log R2
 * sink: per-entry writes land under `gslive-event-logs/<date>/<betId>-<eventId>.json`, the index
 * lists each entry once with its key, and the sink rejects unsafe identifiers before touching R2.
 */

import { describe, expect, test } from "bun:test";

import {
  buildGsliveEventLogArtifacts,
  GSLIVE_EVENT_LOGS_INDEX_KEY,
  GSLIVE_EVENT_LOGS_PREFIX,
  GSLIVE_EVENT_LOGS_SCHEMA_VERSION,
  GSLIVE_EVENT_LOGS_SOURCE,
  publishGsliveEventLogs,
  type GsliveEventLogsIndex,
} from "../lib/gslive_event_log_sink.ts";
import { R2S3Client, type R2S3ClientBackend } from "../lib/r2_s3_client.ts";

class FakeBackend implements R2S3ClientBackend {
  file(): Bun.S3File {
    return undefined as unknown as Bun.S3File;
  }
  async write(): Promise<number> {
    return 1;
  }
  presign(path: string): string {
    return `https://r2.test/${path}`;
  }
  async stat(): Promise<Bun.S3Stats> {
    return {
      size: 1,
      lastModified: new Date(0),
      etag: "e",
      type: "application/json",
    };
  }
  async exists(): Promise<boolean> {
    return true;
  }
  async size(): Promise<number> {
    return 1;
  }
  async list(): Promise<Bun.S3ListObjectsResponse> {
    return { contents: [], isTruncated: false };
  }
  async delete(): Promise<void> {}
  async unlink(): Promise<void> {}
}

type RecordedFetchWrite = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyBytes: Uint8Array;
};

function fakeFetchFor(records: RecordedFetchWrite[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers ?? {});
    const bodyBytes =
      init?.body instanceof Uint8Array
        ? init.body
        : new TextEncoder().encode(String(init?.body ?? ""));
    records.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      bodyBytes,
    });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

function makeClient(): R2S3Client {
  return new R2S3Client(
    new FakeBackend(),
    "sportsdesk-ops-reports",
    "https://pub.r2.dev",
    {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secrettestsecrettestsecrettestsecret",
    },
  );
}

const INPUT = {
  deskDate: "2026-11-04",
  observedAtIso: "2026-11-04T19:10:00.000Z",
  entries: [
    {
      betId: "350826311",
      eventId: "207059641",
      logTime: "19:08:12",
      payload: { status: "open" },
    },
    {
      betId: "350826312",
      eventId: "207059642",
      logTime: "19:09:03",
      payload: { status: "settled" },
    },
  ],
} as const;

describe("buildGsliveEventLogArtifacts", () => {
  test("writes one artifact per entry plus the index as the last entry", () => {
    const artifacts = buildGsliveEventLogArtifacts(INPUT);
    expect(artifacts).toHaveLength(3);
    expect(artifacts[0]?.key).toBe(
      `${GSLIVE_EVENT_LOGS_PREFIX}2026-11-04/350826311-207059641.json`,
    );
    expect(artifacts[1]?.key).toBe(
      `${GSLIVE_EVENT_LOGS_PREFIX}2026-11-04/350826312-207059642.json`,
    );
    expect(artifacts[2]?.key).toBe(GSLIVE_EVENT_LOGS_INDEX_KEY);
  });

  test("per-entry metadata names desk-date, bet-id, event-id and pii stance", () => {
    const [first] = buildGsliveEventLogArtifacts(INPUT);
    expect(first?.extraMetadata).toEqual({
      "desk-date": "2026-11-04",
      "bet-id": "350826311",
      "event-id": "207059641",
      pii: "caller-sanitized",
    });
  });

  test("the index lists every entry once with its key and observed-at", () => {
    const artifacts = buildGsliveEventLogArtifacts(INPUT);
    const indexArtifact = artifacts.at(-1);
    const parsed = JSON.parse(
      indexArtifact?.text ?? "{}",
    ) as GsliveEventLogsIndex;
    expect(parsed.schemaVersion).toBe(GSLIVE_EVENT_LOGS_SCHEMA_VERSION);
    expect(parsed.deskDate).toBe("2026-11-04");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toEqual({
      key: `${GSLIVE_EVENT_LOGS_PREFIX}2026-11-04/350826311-207059641.json`,
      betId: "350826311",
      eventId: "207059641",
      logTime: "19:08:12",
      observedAtIso: "2026-11-04T19:10:00.000Z",
    });
  });

  test("rejects unsafe betId before any key is built", () => {
    expect(() =>
      buildGsliveEventLogArtifacts({
        ...INPUT,
        entries: [
          {
            betId: "../../etc/passwd",
            eventId: "e",
            logTime: "0",
            payload: {},
          },
        ],
      }),
    ).toThrow(/betId must match/);
  });

  test("rejects unsafe eventId", () => {
    expect(() =>
      buildGsliveEventLogArtifacts({
        ...INPUT,
        entries: [{ betId: "b", eventId: "e/f", logTime: "0", payload: {} }],
      }),
    ).toThrow(/eventId must match/);
  });

  test("rejects malformed deskDate", () => {
    expect(() =>
      buildGsliveEventLogArtifacts({ ...INPUT, deskDate: "2026-11-4" }),
    ).toThrow(/deskDate must be YYYY-MM-DD/);
  });
});

describe("publishGsliveEventLogs", () => {
  test("publishes every artifact in order and names the sink module as source", async () => {
    const records: RecordedFetchWrite[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(records);
    try {
      const result = await publishGsliveEventLogs(makeClient(), INPUT);
      expect(result.ok).toBe(true);
      expect(result.writes).toHaveLength(3);
      expect(records).toHaveLength(3);
      for (const record of records) {
        expect(record.method).toBe("PUT");
        expect(record.headers["x-amz-meta-source"]).toBe(
          GSLIVE_EVENT_LOGS_SOURCE,
        );
      }
      expect(records.at(-1)?.url).toContain(GSLIVE_EVENT_LOGS_INDEX_KEY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
