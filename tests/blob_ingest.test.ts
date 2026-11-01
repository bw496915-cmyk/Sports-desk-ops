import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCaptureRecordFromBlob,
  fetchVerifiedBlob,
  ingestF402ReportBlob,
  inspectBlobSource,
  parseF402ListEnvelope,
  toBlob,
  writeVerifiedBlob,
} from "../lib/blob_ingest.ts";
import { createWagerSettlementStore } from "../lib/fantasy402_settlement_ingest.ts";
import { encodeScreenshotBlob } from "../lib/screenshot_encode.ts";
import { CaptureStore, loadCaptureStore } from "../scripts/capture/recorder.ts";
import { handleProxyRequest } from "../scripts/net/record_proxy.ts";

describe("Blob unification & ingestion pipeline (lib/blob_ingest.ts)", () => {
  test("parseF402ListEnvelope handles polymorphic LIST: '' empty string, null, populated array, and throws on invalid types", () => {
    expect(parseF402ListEnvelope({ LIST: "" })).toEqual([]);
    expect(parseF402ListEnvelope({ LIST: null })).toEqual([]);
    expect(parseF402ListEnvelope({})).toEqual([]);
    expect(
      parseF402ListEnvelope({
        LIST: [{ TicketNumber: 1, WagerNumber: 1 }],
      }),
    ).toEqual([{ TicketNumber: 1, WagerNumber: 1 }]);

    expect(() => parseF402ListEnvelope({ LIST: 123 })).toThrow(
      /unexpected LIST shape: number/,
    );
    expect(() => parseF402ListEnvelope({ LIST: { bad: true } })).toThrow(
      /unexpected LIST shape: object/,
    );
  });

  test("inspectBlobSource normalizes Blob, Response, Uint8Array, and string with deterministic SHA-256", async () => {
    const payload = JSON.stringify({ LIST: "" });
    const fromString = await inspectBlobSource(payload, "application/json");
    const fromBytes = await inspectBlobSource(
      new TextEncoder().encode(payload),
      "application/json",
    );
    const fromResponse = await inspectBlobSource(
      new Response(payload, {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );

    expect(fromString.size).toBe(11);
    expect(fromString.sha256).toBe(fromBytes.sha256);
    expect(fromString.sha256).toBe(fromResponse.sha256);
    expect(fromResponse.mimeType).toContain("application/json");
  });

  test("writeVerifiedBlob writes via Bun.write and verifies Bun.file(dest).size === blob.size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blob-ingest-write-"));
    try {
      const dest = join(dir, "nested", "sample.json");
      const blob = await toBlob('{"ok":true}', "application/json");
      const res = await writeVerifiedBlob(dest, blob);

      expect(res.writtenBytes).toBe(11);
      expect(res.size).toBe(11);
      const diskBlob = Bun.file(dest);
      expect(diskBlob.size).toBe(11);
      expect(await diskBlob.json()).toEqual({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fetchVerifiedBlob enforces content-length on identity responses and allows compressed wire-length mismatch", async () => {
    const mockFetcher = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/identity-ok") {
        const body = '{"hello":"world"}';
        return new Response(body, {
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
          },
        });
      }
      if (url.pathname === "/identity-truncated") {
        const body = '{"hello":"world"}';
        return new Response(body, {
          headers: {
            "content-type": "application/json",
            "content-length": "999",
          },
        });
      }
      if (url.pathname === "/gzip-ok") {
        const raw = JSON.stringify({
          repeated: "sportsdesk-ops-blob-unification-".repeat(20),
        });
        const compressed = Bun.gzipSync(new TextEncoder().encode(raw));
        return new Response(raw, {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
          },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const baseUrl = "https://api.github.com";

    const identityRes = await fetchVerifiedBlob(`${baseUrl}/identity-ok`, {
      fetcher: mockFetcher,
    });
    expect(identityRes.status).toBe(200);
    expect(identityRes.wireCompressed).toBe(false);
    expect(identityRes.size).toBe(17);
    expect(identityRes.wireContentLength).toBe(17);

    await expect(
      fetchVerifiedBlob(`${baseUrl}/identity-truncated`, {
        fetcher: mockFetcher,
      }),
    ).rejects.toThrow(/truncated response/);

    const gzipRes = await fetchVerifiedBlob(`${baseUrl}/gzip-ok`, {
      fetcher: mockFetcher,
    });
    expect(gzipRes.status).toBe(200);
    expect(gzipRes.wireCompressed).toBe(true);
    expect(gzipRes.wireContentLength).toBeLessThan(gzipRes.size);
    expect(gzipRes.size).toBeGreaterThan(500);

    await expect(
      fetchVerifiedBlob(`${baseUrl}/missing`, { fetcher: mockFetcher }),
    ).rejects.toThrow(/HTTP 404/);
  });

  test("buildCaptureRecordFromBlob bridges Response/Blob and Bun.Image screenshot Blobs into CaptureRecord", async () => {
    const apiResponse = new Response(
      JSON.stringify({
        Pending: [
          {
            TicketNumber: 91001,
            WagerNumber: 1,
            CustomerID: "H1716",
            AgentID: "MILLER500",
            AmountWagered: 5000,
            ToWinAmount: 4545,
            WagerType: "S",
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );

    const record = await buildCaptureRecordFromBlob({
      mode: "live",
      capturedAt: "2026-11-01T02:07:38.875Z",
      operation: {
        path: "/cloud/api/Report/Pending",
        method: "POST",
        operationId: "Pending",
      },
      request: {
        url: "https://fantasy402.com/cloud/api/Report/Pending",
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        contentType: "application/x-www-form-urlencoded; charset=UTF-8",
        body: "customerID=H1716&operation=Pending&RRO=1",
      },
      response: apiResponse,
      provenance: {
        portalHost: "fantasy402.com",
        proxy: "none",
        auth: "cookie",
        bunVersion: Bun.version,
      },
    });

    expect(record.response?.status).toBe(200);
    expect(record.response?.contentType).toContain("application/json");
    expect(record.redaction.clean).toBe(true);
    expect(record.redaction.piiRedacted).toContain("customer-id");
    expect(record.response?.bodySkeleton).toEqual({
      type: "object",
      nullable: false,
      fields: {
        Pending: {
          type: "array",
          nullable: false,
          items: {
            type: "object",
            nullable: false,
            fields: {
              AgentID: { type: "string", nullable: false },
              AmountWagered: { type: "number", nullable: false },
              CustomerID: { type: "string", nullable: false },
              TicketNumber: { type: "number", nullable: false },
              ToWinAmount: { type: "number", nullable: false },
              WagerNumber: { type: "number", nullable: false },
              WagerType: {
                type: "string",
                nullable: false,
                enumCandidates: ["S"],
              },
            },
          },
        },
      },
    });

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const pngBytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    const webpBlob = await encodeScreenshotBlob(pngBytes, {
      format: "webp",
      quality: 80,
      resize: { width: 16, height: 9 },
    });
    const inspectedWebp = await inspectBlobSource(webpBlob);
    expect(inspectedWebp.mimeType).toBe("image/webp");
    expect(inspectedWebp.size).toBeGreaterThan(0);
  });

  test("ingestF402ReportBlob ingests raw Pending/Grading Blobs, empty LIST: '' envelopes, and populates WagerSettlementStore", async () => {
    const emptyRes = await ingestF402ReportBlob('{"LIST":""}');
    expect(emptyRes.envelopeKind).toBe("empty-list");
    expect(emptyRes.rawRowCount).toBe(0);
    expect(emptyRes.groupedTickets).toEqual([]);

    const store = createWagerSettlementStore();
    const probeEnvelope = {
      kind: "webview-probe",
      operation: "Pending",
      path: "/cloud/api/Report/Pending",
      capturedAt: "2026-11-01T02:07:38.875Z",
      response: {
        ok: true,
        status: 200,
        contentType: "application/json; charset=utf-8",
        bytes: 46628,
        bodyPreview: JSON.stringify({
          Pending: [
            {
              TicketNumber: "880100",
              WagerNumber: "1",
              CustomerID: "H1716",
              AgentID: "MILLER500",
              AmountWagered: 10000,
              ToWinAmount: 26000,
              WagerType: "P",
              SportType: "NBA",
              ChosenTeamID: "BOS",
              Team1ID: "BOS",
              Team2ID: "LAL",
              Team1RotNum: 501,
              Team2RotNum: 502,
              AdjSpread: -4.5,
              PeriodNumber: 0,
            },
            {
              TicketNumber: "880100",
              WagerNumber: "1",
              CustomerID: "H1716",
              AgentID: "MILLER500",
              AmountWagered: 10000,
              ToWinAmount: 26000,
              WagerType: "P",
              SportType: "NBA",
              ChosenTeamID: "DEN",
              Team1ID: "DEN",
              Team2ID: "PHX",
              Team1RotNum: 503,
              Team2RotNum: 504,
              AdjTotalPoints: 224.5,
              TotalPointsOU: "o",
              PeriodNumber: 0,
            },
          ],
        }),
      },
    };

    const blob = new Blob([JSON.stringify(probeEnvelope)], {
      type: "application/json",
    });

    const result = await ingestF402ReportBlob(blob, {
      settlementStore: store,
      capturedAtUtc: "2026-11-01T02:07:38.875Z",
    });

    expect(result.envelopeKind).toBe("webview-probe");
    expect(result.operation).toBe("Pending");
    expect(result.wireBytes).toBe(46628);
    expect(result.rawRowCount).toBe(2);
    expect(result.groupedTickets).toHaveLength(1);
    expect(result.groupedTickets[0]?.ticketGroupKey).toBe("880100-1");
    expect(result.groupedTickets[0]?.legs).toHaveLength(2);
    expect(result.groupedTickets[0]?.customerId).toBe("H1716");
    expect(result.settlementIngestedCount).toBe(2);
    expect(store.countObservations()).toBe(2);
  });

  test("handleProxyRequest records Blob SHA-256 in journal and promotes 2xx /cloud/api/ responses into CaptureStore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-blob-test-"));
    try {
      const journalPath = join(dir, "proxy.jsonl");
      const promoteDir = join(dir, "captures");
      const promoteStore = new CaptureStore({ root: promoteDir });

      const req = new Request(
        "http://fantasy402.com/cloud/api/Manager/getTransactions",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            cookie: "session=secret-session-cookie",
          },
          body: "customerID=H1716&operation=getTransactions&RRO=1",
        },
      );

      const { response, journalRecord } = await handleProxyRequest(req, {
        allow: new Set(["fantasy402.com"]),
        journalPath,
        promoteStore,
        quiet: true,
        fetcher: async () =>
          new Response('{"LIST":""}', {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ LIST: "" });
      expect(journalRecord).not.toBeNull();
      expect(journalRecord?.responseBytes).toBe(11);
      expect(journalRecord?.responseMimeType).toContain("application/json");
      expect(journalRecord?.requestHeaders["cookie"]).toBe("<redacted>");
      expect(journalRecord?.promotedCaptureHash).toMatch(/^[0-9a-f]{64}$/);

      const loaded = await loadCaptureStore(promoteDir);
      expect(loaded.captures).toHaveLength(1);
      expect(loaded.captures[0]?.record.operation.path).toBe(
        "/cloud/api/Manager/getTransactions",
      );
      expect(loaded.captures[0]?.record.provenance.proxy).toBe("env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
