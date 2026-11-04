/**
 * @file gslive_weblog_sink.test.ts
 * @description Validates the two-write pattern of the GSLive weblogs R2 sink: daily under
 * `gslive-weblogs/<date>/activity.json` then the pointer at `gslive-weblogs/latest.json` that
 * names the daily key.
 */

import { describe, expect, test } from "bun:test";

import {
  buildGsliveWeblogArtifacts,
  GSLIVE_WEBLOGS_POINTER_KEY,
  GSLIVE_WEBLOGS_PREFIX,
  GSLIVE_WEBLOGS_SCHEMA_VERSION,
  GSLIVE_WEBLOGS_SOURCE,
  publishGsliveWeblog,
  type GsliveWeblogsPointer,
} from "../lib/gslive_weblog_sink.ts";
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
};

function fakeFetchFor(records: RecordedFetchWrite[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    records.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()),
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

const ROLLUP = {
  schemaVersion: GSLIVE_WEBLOGS_SCHEMA_VERSION,
  deskDate: "2026-11-04",
  generatedAtIso: "2026-11-04T19:10:00.000Z",
  sourceSha256: "a".repeat(64),
  rowCount: 1234,
  body: { bets: [], sportTallies: {} },
} as const;

describe("buildGsliveWeblogArtifacts", () => {
  test("yields two artifacts: daily first, pointer second", () => {
    const [daily, pointer] = buildGsliveWeblogArtifacts(ROLLUP);
    expect(daily?.key).toBe(`${GSLIVE_WEBLOGS_PREFIX}2026-11-04/activity.json`);
    expect(pointer?.key).toBe(GSLIVE_WEBLOGS_POINTER_KEY);
  });

  test("pointer body names the daily key, matches sha256, and carries the row count", () => {
    const [, pointerArtifact] = buildGsliveWeblogArtifacts(ROLLUP);
    const parsed = JSON.parse(
      pointerArtifact?.text ?? "{}",
    ) as GsliveWeblogsPointer;
    expect(parsed).toEqual({
      schemaVersion: GSLIVE_WEBLOGS_SCHEMA_VERSION,
      deskDate: "2026-11-04",
      key: `${GSLIVE_WEBLOGS_PREFIX}2026-11-04/activity.json`,
      sha256: "a".repeat(64),
      generatedAtIso: "2026-11-04T19:10:00.000Z",
      rowCount: 1234,
    });
  });

  test("the two artifacts advertise matching desk-date metadata and distinct pii stances", () => {
    const [daily, pointer] = buildGsliveWeblogArtifacts(ROLLUP);
    expect(daily?.extraMetadata?.["desk-date"]).toBe("2026-11-04");
    expect(pointer?.extraMetadata?.["desk-date"]).toBe("2026-11-04");
    expect(daily?.extraMetadata?.pii).toBe("caller-sanitized");
    expect(pointer?.extraMetadata?.pii).toBe("none");
  });

  test("rejects malformed deskDate", () => {
    expect(() =>
      buildGsliveWeblogArtifacts({ ...ROLLUP, deskDate: "2026/11/04" }),
    ).toThrow(/deskDate must be YYYY-MM-DD/);
  });
});

describe("publishGsliveWeblog", () => {
  test("publishes daily then pointer and the source header names the sink module", async () => {
    const records: RecordedFetchWrite[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(records);
    try {
      const result = await publishGsliveWeblog(makeClient(), ROLLUP);
      expect(result.ok).toBe(true);
      expect(records).toHaveLength(2);
      expect(records[0]?.url).toContain(
        "/gslive-weblogs/2026-11-04/activity.json",
      );
      expect(records[1]?.url).toContain(GSLIVE_WEBLOGS_POINTER_KEY);
      for (const record of records) {
        expect(record.headers["x-amz-meta-source"]).toBe(GSLIVE_WEBLOGS_SOURCE);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
