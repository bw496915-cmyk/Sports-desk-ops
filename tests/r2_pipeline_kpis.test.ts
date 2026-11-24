import type { WeblogAccountCoverage } from "../lib/f402_weblog_capture.ts";
import { describe, expect, spyOn, test } from "bun:test";
import {
  createR2PipelineS3Fetcher,
  parseDataWindowEndMs,
  probeR2PipelineKpis,
  R2_DATA_STALE_SECONDS,
  type R2PipelineFetcher,
} from "../lib/r2_pipeline_kpis.ts";
import { R2S3Client } from "../lib/r2_s3_client.ts";
import { R2_PUBLIC_BASE } from "../lib/r2_staleness.ts";

describe("parseDataWindowEndMs", () => {
  test("reads weblog window.toMs", () => {
    expect(parseDataWindowEndMs({ window: { toMs: 1_762_300_799_000 } })).toBe(
      1_762_300_799_000,
    );
  });

  test("reads wagers observedEnd", () => {
    const ms = Date.parse("2026-11-04T12:00:00.000Z");
    expect(
      parseDataWindowEndMs({
        window: { observedEnd: "2026-11-04T12:00:00.000Z" },
      }),
    ).toBe(ms);
  });

  test("reads gslive toEpochSec", () => {
    expect(
      parseDataWindowEndMs({ window: { toEpochSec: 1_762_000_000 } }),
    ).toBe(1_762_000_000_000);
  });
});

describe("probeR2PipelineKpis", () => {
  test("maps HEAD Last-Modified into ageSeconds and stale", async () => {
    const now = new Date("2026-11-09T04:00:00.000Z");
    const last = new Date("2026-11-04T04:37:28.000Z");
    const fetchImpl: R2PipelineFetcher = async (url, init) => {
      if (init?.method === "GET") {
        return new Response(null, { status: 404 });
      }
      const key = url.split("/").slice(-2).join("/");
      if (key === "gslive-tally/latest.json") {
        return new Response(null, {
          status: 200,
          headers: { "last-modified": last.toUTCString() },
        });
      }
      if (key === "f402-bet-ticker/latest.json") {
        return new Response(null, {
          status: 200,
          headers: {
            "last-modified": new Date("2026-11-09T03:45:00.000Z").toUTCString(),
          },
        });
      }
      return new Response(null, { status: 404 });
    };
    const kpis = await probeR2PipelineKpis(now, fetchImpl);
    expect(kpis["f402-bet-ticker"]?.stale).toBe(false);
    expect(kpis["gslive-tally"]?.stale).toBe(true);
    expect(kpis["gslive-tally"]?.ageSeconds).toBeGreaterThan(400_000);
  });

  test("separates publish freshness from rollup data age", async () => {
    const now = new Date("2026-11-09T04:00:00.000Z");
    const publishLast = new Date("2026-11-09T03:00:00.000Z");
    const toMs = Date.parse("2026-11-04T23:59:59.000Z");
    const fetchImpl: R2PipelineFetcher = async (url, init) => {
      if (init?.method === "HEAD") {
        if (url.endsWith("f402-weblog/latest.json")) {
          return new Response(null, {
            status: 200,
            headers: { "last-modified": publishLast.toUTCString() },
          });
        }
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("f402-weblog/latest.json")) {
        return Response.json({
          key: "f402-weblog/2026-11-04/rollup.json",
        });
      }
      if (url.endsWith("f402-weblog/2026-11-04/rollup.json")) {
        return Response.json({ window: { toMs } });
      }
      return new Response(null, { status: 404 });
    };
    const kpis = await probeR2PipelineKpis(now, fetchImpl);
    const weblog = kpis["f402-weblog"];
    expect(weblog?.stale).toBe(false);
    expect(weblog?.dataAgeSeconds).toBeGreaterThan(R2_DATA_STALE_SECONDS);
    expect(weblog?.dataStale).toBe(true);
    expect(weblog?.dataWindowToMs).toBe(toMs);
  });
});

test("weblog KPI exposes scoped account coverage and marks legacy coverage unmeasured", async () => {
  const coverage: WeblogAccountCoverage = {
    scope: "live-pending-accounts",
    wholeBookComplete: false,
    snapshotCapturedAt: "2026-11-19T12:00:00Z",
    capturedAt: "2026-11-19T12:05:00Z",
    reportDate: "2026-11-19",
    snapshotTicketRows: 50,
    unidentifiedTicketRows: 5,
    eligibleAccounts: 20,
    requestedAccounts: 20,
    completedAccounts: 20,
    accountsWithActivity: 18,
    emptyAccounts: 2,
    failedAccounts: 0,
    activityRows: 658,
  };
  const result = await probeR2PipelineKpis(
    new Date("2026-11-19T12:10:00Z"),
    async (url, init) =>
      init?.method === "HEAD"
        ? new Response(null, {
            headers: { "last-modified": "Thu, 19 Nov 2026 12:05:00 GMT" },
          })
        : Response.json(
            url.includes("f402-weblog")
              ? {
                  coverage,
                  window: { toMs: Date.parse("2026-11-19T12:00:00Z") },
                }
              : {},
          ),
  );
  expect(result["f402-weblog"]?.accountCoverage).toEqual(coverage);
  const legacy = await probeR2PipelineKpis(new Date(), async () =>
    Response.json({}),
  );
  expect(legacy["f402-weblog"]?.accountCoverage).toBeNull();
});

describe("createR2PipelineS3Fetcher", () => {
  const signedUrl = "https://signed.example/object?X-Amz-Signature=secret";

  test("presigns public R2 keys and keeps the request method", async () => {
    const presigned: { key: string; method: string | undefined }[] = [];
    const fetched: string[] = [];
    const fetcher = createR2PipelineS3Fetcher(
      {
        presign: (key, options) => {
          presigned.push({ key, method: options?.method });
          return signedUrl;
        },
      },
      async (url) => {
        fetched.push(url);
        return new Response(null, { status: 200 });
      },
    );
    const response = await fetcher(
      `${R2_PUBLIC_BASE}/gslive-tally/latest.json`,
      { method: "HEAD" },
    );
    expect(response.status).toBe(200);
    expect(presigned).toEqual([
      { key: "gslive-tally/latest.json", method: "HEAD" },
    ]);
    expect(fetched).toEqual([signedUrl]);
  });

  test("passes a non-R2 URL through unsigned", async () => {
    const presigned: string[] = [];
    const fetched: string[] = [];
    const fetcher = createR2PipelineS3Fetcher(
      {
        presign: (key) => {
          presigned.push(key);
          return signedUrl;
        },
      },
      async (url) => {
        fetched.push(url);
        return new Response(null, { status: 200 });
      },
    );
    await fetcher("https://example.test/latest.json", { method: "GET" });
    expect(presigned).toEqual([]);
    expect(fetched).toEqual(["https://example.test/latest.json"]);
  });

  test("does not leak the signature when the signed request fails", async () => {
    const fetcher = createR2PipelineS3Fetcher(
      { presign: () => signedUrl },
      async () => {
        throw new TypeError(`fetch failed for ${signedUrl}`);
      },
    );
    const error = await fetcher(`${R2_PUBLIC_BASE}/f402-weblog/latest.json`, {
      method: "GET",
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const message = String((error as Error).message);
    expect(message).not.toContain("X-Amz-Signature");
    expect(message).toContain("f402-weblog/latest.json");
    // preserve-caught-error: the rethrow carries the cause *name*, not the raw
    // error (which quotes the presigned URL).
    expect((error as Error).cause).toBe("TypeError");
  });
});

describe("probeR2PipelineKpis transport", () => {
  /** A fetch double that also carries Bun's `preconnect` arm, so it is `typeof fetch`. */
  function stubFetch(
    respond: (url: string) => Response | Promise<Response>,
  ): typeof fetch {
    return Object.assign(
      async (input: string | URL | Request) => respond(String(input)),
      { preconnect: () => {} },
    ) as typeof fetch;
  }

  test("routes the default probe through a presigned client", async () => {
    const presign = (key: string) =>
      `https://signed.example/${key}?X-Amz-Signature=secret`;
    const fromEnv = spyOn(R2S3Client, "fromEnvOrSecrets").mockResolvedValue({
      presign,
    } as unknown as R2S3Client);
    const fetched: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      stubFetch((url) => {
        fetched.push(url);
        return new Response(null, {
          status: 200,
          headers: { "last-modified": new Date().toUTCString() },
        });
      }),
    );
    try {
      await probeR2PipelineKpis(new Date("2026-11-24T16:30:00Z"));
      expect(fromEnv).toHaveBeenCalledTimes(1);
      expect(fetched.length).toBeGreaterThan(0);
      for (const url of fetched) {
        expect(url.startsWith("https://signed.example/")).toBe(true);
      }
    } finally {
      fetchSpy.mockRestore();
      fromEnv.mockRestore();
    }
  });

  test("keeps the anonymous fetch when no credentials resolve", async () => {
    const fromEnv = spyOn(R2S3Client, "fromEnvOrSecrets").mockResolvedValue(
      null,
    );
    const fetched: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      stubFetch((url) => {
        fetched.push(url);
        return new Response(null, { status: 401 });
      }),
    );
    try {
      const kpis = await probeR2PipelineKpis(new Date("2026-11-24T16:30:00Z"));
      expect(kpis["gslive-tally"]?.state).toBe("unreadable");
      expect(fetched.length).toBeGreaterThan(0);
      for (const url of fetched) {
        expect(url.startsWith(R2_PUBLIC_BASE)).toBe(true);
        expect(url.includes("X-Amz-Signature")).toBe(false);
      }
    } finally {
      fetchSpy.mockRestore();
      fromEnv.mockRestore();
    }
  });
});
