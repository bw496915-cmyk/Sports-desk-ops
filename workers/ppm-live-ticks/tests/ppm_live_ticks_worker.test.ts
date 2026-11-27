import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeReconnectBackoffMs,
  defaultMonotonicClock,
  defaultWallClock,
  deskDateUtc,
  elapsedMsFromNs,
  lazyRandomHex,
  timingSafeBearerMatch,
} from "../src/clocks.ts";
import {
  flushLineTicksBatchToR2,
  flushTicksBatchToR2,
  normalizeStrongEtag,
  PPM_LINE_TICKS_MANIFEST_KEY,
  PPM_TICKS_MANIFEST_KEY,
  type PpmLineTickRecord,
  type PpmTickRecord,
  type PpmTicksTaxonomy,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectHeadLike,
  type R2PutOptionsLike,
} from "../src/r2_cas_flush.ts";
import {
  applyJsonPatchInPlace,
  decodeSpandoraFrame,
  EVENT_DATA_LOCK_RE,
  extractLeagueCatalog,
  extractLiveEventsFromEventData,
  extractMarketLinesFromCoefficients,
  extractScoreSnapshot,
  PPM_DEFAULT_LINE_SET,
  parseBinaryAttachmentTopic,
} from "../src/spandora_wire.ts";

class InMemoryCasR2Bucket implements R2BucketLike {
  readonly objects = new Map<
    string,
    { body: string; etag: string; weak?: boolean }
  >();
  private seq = 0;
  public forceConflictOnce = false;

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    const etag = entry.weak ? `W/"${entry.etag}"` : `"${entry.etag}"`;
    return {
      etag: entry.etag,
      httpEtag: etag,
      async text() {
        return entry.body;
      },
    };
  }

  async put(
    key: string,
    value:
      string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectHeadLike | null> {
    const existing = this.objects.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && existing !== undefined) {
      return null;
    }
    if (options?.onlyIf?.etagMatches !== undefined) {
      if (this.forceConflictOnce && key === PPM_TICKS_MANIFEST_KEY) {
        this.forceConflictOnce = false;
        // Simulate concurrent writer advancing ETag before our put landed
        this.seq += 1;
        if (existing) existing.etag = `etag-${this.seq}`;
        return null;
      }
      if (!existing || existing.etag !== options.onlyIf.etagMatches) {
        return null;
      }
    }
    this.seq += 1;
    const nextEtag = `etag-${this.seq}`;
    const body = typeof value === "string" ? value : "";
    this.objects.set(key, { body, etag: nextEtag });
    return { etag: nextEtag, httpEtag: `"${nextEtag}"` };
  }
}

const TAXONOMY: PpmTicksTaxonomy = {
  office: "buckeye",
  supplier: "ganchrow",
  partnerId: 118,
  endpoint: "ppm-live-ticks",
  provenance: "live_api",
};

describe("ppm-live-ticks clocks, lazy entropy & constant-time auth", () => {
  test("separates monotonic ns durations from wall-clock ms timestamps and computes bounded backoff", () => {
    const t0 = defaultMonotonicClock.nowNs();
    const t1 = defaultMonotonicClock.nowNs();
    expect(t1 >= t0).toBe(true);
    expect(elapsedMsFromNs(t0, t0 + 12_500_000n)).toBe(12.5);
    expect(elapsedMsFromNs(t0 + 5n, t0)).toBe(0);

    const wallMs = defaultWallClock.nowMs();
    expect(wallMs).toBeGreaterThan(1_700_000_000_000);
    expect(deskDateUtc(1_795_624_000_000)).toBe("2026-11-25");

    // Lazy runtime entropy works cleanly without any top-level call
    expect(lazyRandomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(computeReconnectBackoffMs(0, 1_000, 30_000, () => 0)).toBe(1_000);
    expect(computeReconnectBackoffMs(10, 1_000, 30_000, () => 0.99)).toBe(
      30_000,
    );
  });

  test("timingSafeBearerMatch validates exact bearer tokens and rejects missing/mismatched tokens", async () => {
    expect(
      await timingSafeBearerMatch(
        "Bearer super-secret-token",
        "super-secret-token",
      ),
    ).toBe(true);
    expect(
      await timingSafeBearerMatch(
        "bearer super-secret-token",
        "super-secret-token",
      ),
    ).toBe(true);
    expect(
      await timingSafeBearerMatch("Bearer wrong", "super-secret-token"),
    ).toBe(false);
    expect(await timingSafeBearerMatch(null, "super-secret-token")).toBe(false);
    expect(
      await timingSafeBearerMatch("Bearer super-secret-token", undefined),
    ).toBe(false);
  });
});

describe("Web-standard DecompressionStream Spandora wire decoder", () => {
  test("decodes gzip snapshot objects and RFC-6902 patch arrays cleanly", async () => {
    expect(
      parseBinaryAttachmentTopic(
        '451-["live.main.U0VWU1NWUkJSMFU9.eventData",{}]',
      ),
    ).toBe("live.main.U0VWU1NWUkJSMFU9.eventData");

    const snapObj = {
      isDiff: false,
      ti: { h: "abc", t: 1_795_624_000_000 },
      payload: {
        s: {
          "5": {
            "170": {
              "3056": {
                "210157911": [
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  { ip: true, l: false, ht: false, s: 1 },
                ],
              },
            },
          },
        },
      },
    };
    const gzSnap = Bun.gzipSync(Buffer.from(JSON.stringify(snapObj)));
    const decodedSnap = await decodeSpandoraFrame(gzSnap);
    expect(decodedSnap.isDiff).toBe(false);
    expect(decodedSnap.payload).not.toBeNull();
    expect(decodedSnap.rawSha256).toMatch(/^[0-9a-f]{64}$/);

    const liveEvents = extractLiveEventsFromEventData(decodedSnap.payload!);
    expect(liveEvents).toEqual([
      {
        eventId: 210157911,
        sportId: 5,
        leagueId: 3056,
        inPlay: true,
        isBlocked: false,
        halfTime: false,
        stateCode: 1,
      },
    ]);

    // Real NHL prematch frame: /s/<sportId=4>/<countryId=213>/<leagueId=10>/<eventId=210142651>
    const nhlEvents = extractLiveEventsFromEventData({
      s: {
        "4": {
          "213": {
            "10": {
              "210142651": [
                ["Winnipeg Jets"],
                ["Boston Bruins"],
                1795651200,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                "league:10",
                true,
                { il: true, l: true, n: 5, s: 0 },
              ],
            },
          },
        },
      },
    });
    expect(nhlEvents).toEqual([
      {
        eventId: 210142651,
        sportId: 4,
        leagueId: 10,
        inPlay: false,
        isBlocked: true,
        halfTime: false,
        stateCode: 0,
      },
    ]);
    const lockMatch = EVENT_DATA_LOCK_RE.exec("/s/5/4/297/207803491/12/l");
    expect(Number(lockMatch?.[1])).toBe(5);
    expect(Number(lockMatch?.[3])).toBe(297);
    expect(Number(lockMatch?.[4])).toBe(207803491);

    const patchFrame = {
      isDiff: true,
      payload: [{ op: "replace", path: "/m/m/0", value: 2 }],
    };
    const gzPatch = Bun.gzipSync(Buffer.from(JSON.stringify(patchFrame)));
    const decodedPatch = await decodeSpandoraFrame(gzPatch);
    expect(decodedPatch.isDiff).toBe(true);
    expect(decodedPatch.patch).toHaveLength(1);

    const coeffDoc: Record<string, unknown> = {
      m: { m: [1, 1], gp: 2, t: 315, tu: 1_795_624_005_000 },
    };
    applyJsonPatchInPlace(coeffDoc, decodedPatch.patch!);
    expect(extractScoreSnapshot(coeffDoc)).toEqual({
      homeScore: 2,
      awayScore: 1,
      period: 2,
      clockSec: 315,
      updatedAtMs: 1_795_624_005_000,
    });

    // League catalog parsing from observed live.leagues / prematch.leagues shapes
    const leagues = extractLeagueCatalog({
      "1": { mo: false, n: "MLB Props" },
      "4": { mo: false, n: "NFL", in: "nfl" },
      "5": { in: "ncaa", mo: false },
      "7": { mo: false },
    });
    expect(leagues).toEqual([
      { leagueId: 1, name: "MLB Props", slug: null },
      { leagueId: 4, name: "NFL", slug: "nfl" },
      { leagueId: 5, name: null, slug: "ncaa" },
    ]);
  });
});

describe("R2 content-addressed NDJSON chunk + strong-ETag CAS manifest flush", () => {
  test("writes immutable chunks with If-None-Match: *, strips weak W/ ETags, and retries CAS conflict", async () => {
    expect(normalizeStrongEtag('W/"abc123"')).toBe("abc123");
    expect(normalizeStrongEtag('"def456"')).toBe("def456");

    const bucket = new InMemoryCasR2Bucket();
    const tick1: PpmTickRecord = {
      event_id: 210157911,
      ts_ms: 1_795_624_000_000,
      sport_id: 5,
      league_id: 170,
      home_score: 1,
      away_score: 0,
      period: 1,
      clock_sec: 120,
      is_blocked: 0,
      score_changed: 1,
      source_topic: "live.main.U0VWU1NWUkJSMFU9.eventCoefficients.210157911",
      raw_sha256: "a".repeat(64),
    };

    const res1 = await flushTicksBatchToR2(bucket, [tick1], TAXONOMY, {
      nowMs: () => 1_795_624_010_000,
    });
    expect(res1.flushedRows).toBe(1);
    expect(res1.chunkAlreadyExisted).toBe(false);
    expect(res1.generationU32).toBe(1);
    expect(res1.dataWindowMaxEpochMs).toBe(1_795_624_000_000);
    expect(res1.r2PublishedAtEpochMs).toBe(1_795_624_010_000);

    // Mark stored manifest ETag as weak (`W/"..."`) and inject a single CAS conflict on next flush
    const stored = bucket.objects.get(PPM_TICKS_MANIFEST_KEY)!;
    stored.weak = true;
    bucket.forceConflictOnce = true;

    const res2 = await flushTicksBatchToR2(bucket, [tick1], TAXONOMY, {
      nowMs: () => 1_795_624_020_000,
    });
    expect(res2.chunkAlreadyExisted).toBe(true); // If-None-Match: * prevented chunk clobber!
    expect(res2.generationU32).toBe(2);
    expect(res2.r2PublishedAtEpochMs).toBe(1_795_624_020_000);
    expect(res2.dataWindowMaxEpochMs).toBe(1_795_624_000_000);
  });

  test("extractMarketLinesFromCoefficients parses spread/total/team-total/moneyline and flushes closing line ticks via CAS", async () => {
    const coeffDoc: Record<string, unknown> = {
      m: { m: [0, 0], gp: 0, t: 0, tu: 1_795_624_500_000 },
      c: {
        m: {
          "6": {
            r: -3.5,
            o: {
              "-3.0": [1.85, 1.00001], // placeholder filtered
              "-3.5": [1.88, 1.96],
            },
          },
          "5": {
            r: 47.5,
            o: { "47.5": [1.91, 1.91] },
          },
          "7": {
            r: 24.5,
            o: { "24.5": [1.86, 1.98] },
          },
          "1": {
            o: { "1": 1.68, "2": 2.24 },
          },
        },
        q1: {
          "6": {
            r: -0.5,
            o: { "-0.5": [1.75, 2.15] },
          },
        },
      },
    };

    const extracted = extractMarketLinesFromCoefficients(coeffDoc);
    expect(extracted.length).toBe(5);
    const fgSpread = extracted.find(
      (m) => m.marketKind === "SPREAD" && m.periodKind === "FG",
    );
    expect(fgSpread).toMatchObject({
      marketId: 6,
      line: -3.5,
      oddsA: 1.88,
      oddsB: 1.96,
      twoSided: true,
    });
    const q1Spread = extracted.find(
      (m) => m.marketKind === "SPREAD" && m.periodKind === "Q1",
    );
    expect(q1Spread).toMatchObject({ line: -0.5, oddsA: 1.75, oddsB: 2.15 });
    const fgMl = extracted.find((m) => m.marketKind === "MONEYLINE");
    expect(fgMl).toMatchObject({ oddsA: 1.68, oddsB: 2.24, twoSided: true });

    const bucket = new InMemoryCasR2Bucket();
    const closingTick: PpmLineTickRecord = {
      event_id: 210157911,
      ts_ms: 1_795_624_500_000,
      line_set: PPM_DEFAULT_LINE_SET,
      flavor: "prematch",
      sport_id: 4,
      league_id: 10,
      market_id: 6,
      market_kind: "SPREAD",
      period_kind: "FG",
      line: -3.5,
      odds_a: 1.88,
      odds_b: 1.96,
      is_closing: 1,
      source_topic: `prematch.main.${PPM_DEFAULT_LINE_SET}.eventCoefficients.210157911`,
      raw_sha256: "b".repeat(64),
    };
    const flushed = await flushLineTicksBatchToR2(
      bucket,
      [closingTick],
      TAXONOMY,
      { nowMs: () => 1_795_624_505_000 },
      {
        manifestKey: "manifests/ppm-prematch-lines/latest",
        chunkPrefix: "ppm-prematch-lines/chunks",
        sinkId: "ppm-prematch-lines",
      },
    );
    expect(flushed.flushedRows).toBe(1);
    expect(flushed.generationU32).toBe(1);
    expect(flushed.manifestKey).toBe("manifests/ppm-prematch-lines/latest");
    expect(PPM_LINE_TICKS_MANIFEST_KEY).toBe("manifests/ppm-live-lines/latest");
  });
});

describe("wrangler.jsonc production guardrails", () => {
  test("enforces compatibility_date, SQLite DO migration, full observability, custom domain, and zero workers.dev", () => {
    const raw = readFileSync(
      join(import.meta.dir, "..", "wrangler.jsonc"),
      "utf8",
    );
    const cfg = Bun.JSONC.parse(raw) as Record<string, unknown>;
    expect(cfg.name).toBe("ppm-live-ticks");
    expect(cfg.compatibility_date).toBe("2026-11-25");
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.preview_urls).toBe(false);
    expect(cfg.routes).toEqual([
      { pattern: "ticks.bookdeskops.com", custom_domain: true },
    ]);

    const obs = cfg.observability as Record<string, unknown>;
    expect(obs.enabled).toBe(true);
    expect((obs.logs as Record<string, unknown>).enabled).toBe(true);
    expect((obs.traces as Record<string, unknown>).enabled).toBe(true);

    const migrations = cfg.migrations as Array<Record<string, unknown>>;
    expect(migrations[0]?.new_sqlite_classes).toEqual([
      "PpmLiveTicksCollectorDO",
    ]);
  });

  test("Bun.Transpiler.scan enforces Worker module boundaries, zero Bun/dotenv imports, and DO export parity", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const srcDir = join(import.meta.dir, "..", "src");
    const tsFiles = readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .sort();
    expect(tsFiles).toEqual([
      "clocks.ts",
      "collector_do.ts",
      "index.ts",
      "r2_cas_flush.ts",
      "spandora_wire.ts",
    ]);

    const forbiddenSpecifiers = [
      /^bun(?::|$)/,
      /^dotenv(?:\/|$)/,
      /^node:fs(?:\/|$)/,
      /^node:child_process(?:\/|$)/,
    ];

    for (const file of tsFiles) {
      const code = readFileSync(join(srcDir, file), "utf8");
      const { imports, exports } = transpiler.scan(code);

      for (const imp of imports) {
        // Reject CJS require() or dynamic import() escapes in the Worker bundle graph
        expect(imp.kind).toBe("import-statement");
        for (const pattern of forbiddenSpecifiers) {
          expect(pattern.test(imp.path)).toBe(false);
        }
        // Only collector_do.ts may import cloudflare:workers; pure modules stay portable
        if (imp.path === "cloudflare:workers") {
          expect(file).toBe("collector_do.ts");
        }
      }

      // Entrypoint must export both default Worker handler and the Wrangler DO class
      if (file === "index.ts") {
        expect(exports).toContain("default");
        expect(exports).toContain("PpmLiveTicksCollectorDO");
      }
    }
  });
});
