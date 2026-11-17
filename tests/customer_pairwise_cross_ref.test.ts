import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  R2_BUCKET,
  SYNDICATE_RINGS_MANIFEST_KEY,
  WAGERS_BY_STATE_MANIFEST_KEY,
  assertPairwiseCrossRefLivePreflight,
  executePairwiseCrossRefFromR2,
  type PairwiseR2Reader,
} from "../packages/sportsdesk-ops/src/bin/sportsdesk-fraud-cross-ref.ts";
import {
  LEG_FLAG_IS_ALT_SPREAD_PLUS_5000,
  LEG_FLAG_IS_LIVE_INPLAY,
  LIVE_WAGER_TYPE_CODE3,
  OVERLAP_DIFFERENT_MARKET,
  OVERLAP_OPPOSITE_SIDE,
  OVERLAP_SAME_SIDE,
  PAIRWISE_OVERLAP_SOA_ROW_BYTES,
  PAIRWISE_SOA_CHUNK_MAGIC,
  PAIRWISE_SOA_CHUNK_VERSION,
  PAIRWISE_SOA_HEADER_BYTES,
  PAIRWISE_WAGER_SOA_ROW_BYTES,
  PairwiseOverlapColumnStore,
  PairwiseWagerColumnStore,
  REGIME_LIVE_IN_PLAY,
  REGIME_PREGAME,
  SOURCE_BRIDGE_IDS,
  asLineHundredths,
  encodePairwiseSoAChunk,
  evaluateColumnarPairwiseCrossRef,
  hashCustomerLogin64Stride2,
  hydratePairwiseColumnStoreFromSoAChunk,
  normalizeCanonicalRotation20,
  packSubSportComboKey15,
  parseAsBasisPoints,
  parseAsCents,
  parseDualSurfaceBetGroupToken,
  parseFixedPointDecimalToBigInt,
  readEpochMs64Stride2,
  unpackSubSportComboKey15,
  writeEpochMs64Stride2,
} from "../src/lib/customer_pairwise_cross_ref.ts";

const ROOT = resolve(import.meta.dir, "..");
const RETIRED_ENV_KEYS = [
  "DOD6_SPINE_PATH",
  "DOD_SPINE_PATH",
  "F402_BETS_JSONL_PATH",
  "DOD_SQLITE_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

function makeLiveEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const key of RETIRED_ENV_KEYS) delete env[key];
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_R2_API_TOKEN;
  env.R2_ACCESS_KEY_ID = "test-r2-access";
  env.R2_SECRET_ACCESS_KEY = "test-r2-secret";
  env.R2_ENDPOINT = "https://r2.sportsdesk.test";
  return env;
}

function createInMemoryR2Reader(
  objects: ReadonlyMap<string, Uint8Array>,
): PairwiseR2Reader {
  return {
    file(key: string) {
      return {
        async text() {
          const buf = objects.get(key);
          if (!buf) throw new Error(`NoSuchKey: ${key}`);
          return new TextDecoder().decode(buf);
        },
        async bytes() {
          const buf = objects.get(key);
          if (!buf) throw new Error(`NoSuchKey: ${key}`);
          return buf;
        },
      };
    },
  };
}

describe("src/lib/customer_pairwise_cross_ref primitives & contiguous SoA layout", () => {
  test("parseFixedPointDecimalToBigInt handles Unicode half-point, commas, signs, and padding", () => {
    expect(parseFixedPointDecimalToBigInt("-3.5", 2)).toBe(-350n);
    expect(parseFixedPointDecimalToBigInt("+7½", 2)).toBe(750n);
    expect(parseFixedPointDecimalToBigInt("-½", 2)).toBe(-50n);
    expect(parseFixedPointDecimalToBigInt("1,250.5", 2)).toBe(125050n);
    expect(parseFixedPointDecimalToBigInt(100, 2)).toBe(10000n);
    expect(parseFixedPointDecimalToBigInt("", 2)).toBe(0n);
  });

  test("normalizeCanonicalRotation20 collapses [5000..5999] and [9000..9999] and bounds 20-bit range", () => {
    expect(normalizeCanonicalRotation20(451)).toEqual({
      canonicalRot20: 451,
      flagMask32: 0,
    });
    expect(normalizeCanonicalRotation20(5451)).toEqual({
      canonicalRot20: 451,
      flagMask32: LEG_FLAG_IS_ALT_SPREAD_PLUS_5000,
    });
    expect(normalizeCanonicalRotation20(9451)).toEqual({
      canonicalRot20: 451,
      flagMask32: LEG_FLAG_IS_LIVE_INPLAY,
    });
    expect(() => normalizeCanonicalRotation20(-1)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => normalizeCanonicalRotation20(0x100000)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
  });

  test("parseDualSurfaceBetGroupToken and hashCustomerLogin64Stride2 normalize surfaces identically", () => {
    expect(parseDualSurfaceBetGroupToken("M.G80012345")).toBe(80012345n);
    expect(parseDualSurfaceBetGroupToken("G80012345")).toBe(80012345n);
    expect(parseDualSurfaceBetGroupToken("80012345")).toBe(80012345n);

    const words = new Uint32Array(4);
    hashCustomerLogin64Stride2("player_TTN97", words, 0);
    hashCustomerLogin64Stride2("  ttn97  ", words, 2);
    expect(words[0]).toBe(words[2]);
    expect(words[1]).toBe(words[3]);
  });

  test("PairwiseWagerColumnStore & PairwiseOverlapColumnStore allocate contiguous ArrayBuffer slabs with stride-2 Uint32 timestamp words", () => {
    const store = new PairwiseWagerColumnStore(5);
    expect(store.alignedCapacity).toBe(8);
    expect(store.buffer.byteLength).toBe(8 * PAIRWISE_WAGER_SOA_ROW_BYTES);
    expect(store.placedAtEpochMs32WordsCol).toBeInstanceOf(Uint32Array);
    expect(store.placedAtEpochMs32WordsCol.length).toBe(16);

    for (const col of [
      store.stakeCentsI64Col,
      store.loginKey32WordsCol,
      store.betGroupOrWagerId32WordsCol,
      store.placedAtEpochMs32WordsCol,
      store.canonicalRot20Col,
      store.lineHundredthsI32Col,
      store.oddsAmericanI32Col,
      store.flagsBitSet32Col,
      store.packedComboKey15Col,
      store.concurrentEventAccountCountU16Col,
      store.sourceBridgeU8Col,
      store.sideCodeU8Col,
    ]) {
      expect(col.buffer).toBe(store.buffer);
    }

    const words = new Uint32Array(4);
    writeEpochMs64Stride2(1_763_262_000_450, words, 0);
    writeEpochMs64Stride2(1_763_262_000_450n, words, 2);
    expect(readEpochMs64Stride2(words, 0)).toBe(1_763_262_000_450);
    expect(readEpochMs64Stride2(words, 2)).toBe(1_763_262_000_450);

    const overlaps = new PairwiseOverlapColumnStore(5);
    expect(overlaps.alignedCapacity).toBe(8);
    expect(overlaps.buffer.byteLength).toBe(8 * PAIRWISE_OVERLAP_SOA_ROW_BYTES);
    expect(overlaps.lagMsU32Col).toBeInstanceOf(Uint32Array);
    for (const col of [
      overlaps.canonicalRot20Col,
      overlaps.rowIndexACol,
      overlaps.rowIndexBCol,
      overlaps.lagMsU32Col,
      overlaps.packedComboKey15Col,
      overlaps.overlapKindU8Col,
      overlaps.regimeMask2U8Col,
      overlaps.initiatorCodeU8Col,
      overlaps.flagsU8Col,
    ]) {
      expect(col.buffer).toBe(overlaps.buffer);
    }
  });

  test("contiguous SoA binary chunk round-trip preserves stride-2 ms epoch words, stakeCentsI64, and bridge guards", () => {
    const src = new PairwiseWagerColumnStore(8);
    const key = packSubSportComboKey15(3, LIVE_WAGER_TYPE_CODE3, 0, 0);
    const tsMs = 1_763_262_000_450;

    expect(
      src.appendLeg(
        "BILLY666",
        101n,
        9451,
        key,
        asLineHundredths(-350),
        -115,
        125_075n,
        tsMs,
        SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
        1,
        0,
        9,
      ),
    ).toBe(0);

    // STAGE1_DROP is ignored
    expect(
      src.appendLeg(
        "ALERT_ROW",
        102n,
        451,
        key,
        asLineHundredths(-350),
        -110,
        parseAsCents(5000),
        tsMs,
        SOURCE_BRIDGE_IDS.INGEST_STAGE1_DROP,
        0,
      ),
    ).toBe(-1);

    const chunk = encodePairwiseSoAChunk(src);
    const view = new DataView(
      chunk.buffer,
      chunk.byteOffset,
      PAIRWISE_SOA_HEADER_BYTES,
    );
    expect(view.getUint32(0, true)).toBe(PAIRWISE_SOA_CHUNK_MAGIC);
    expect(view.getUint32(4, true)).toBe(PAIRWISE_SOA_CHUNK_VERSION);
    expect(view.getUint32(8, true)).toBe(1);
    expect(view.getUint32(12, true)).toBe(4);
    expect(chunk.byteLength).toBe(
      PAIRWISE_SOA_HEADER_BYTES + 4 * PAIRWISE_WAGER_SOA_ROW_BYTES,
    );

    const dst = new PairwiseWagerColumnStore(8);
    const hydrated = hydratePairwiseColumnStoreFromSoAChunk(
      chunk,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      dst,
    );
    expect(hydrated).toBe(1);
    expect(dst.canonicalRot20Col[0]).toBe(451);
    expect(dst.packedComboKey15Col[0]).toBe(key);
    expect(unpackSubSportComboKey15(dst.packedComboKey15Col[0]!)).toEqual({
      subSportCode6: 3,
      wagerTypeCode3: LIVE_WAGER_TYPE_CODE3,
      periodCode4: 0,
      marketKindCode2: 0,
    });
    expect(dst.lineHundredthsI32Col[0]).toBe(-350);
    expect(dst.oddsAmericanI32Col[0]).toBe(-115);
    expect(dst.stakeCentsI64Col[0]).toBe(125_075n);
    expect(dst.readPlacedAtEpochMs(0)).toBe(tsMs);
    expect(dst.concurrentEventAccountCountU16Col[0]).toBe(9);
    expect(dst.flagsBitSet32Col[0]).toBe(LEG_FLAG_IS_LIVE_INPLAY);

    // Bridge contamination guard on mismatched expectedBridgeId2
    const mismatchDst = new PairwiseWagerColumnStore(8);
    expect(() =>
      hydratePairwiseColumnStoreFromSoAChunk(
        chunk,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        mismatchDst,
      ),
    ).toThrow(/ERR_BRIDGE_CHANNEL_CONTAMINATION/);
  });
});

describe("evaluateColumnarPairwiseCrossRef follower deduplication & dual-regime", () => {
  test("deduplicates leader re-bets so each follower ticket binds once to closest preceding leader wager (10000ms)", () => {
    const store = new PairwiseWagerColumnStore(8);
    const key17410 = 17410 as ReturnType<typeof packSubSportComboKey15>;
    const t0 = 1_763_262_000_000;

    // rowIndexA: 0 and rowIndexA: 1 on same (canonicalRot20=889598, packedComboKey15=17410)
    expect(
      store.appendLeg(
        "C001",
        1n,
        889598,
        key17410,
        asLineHundredths(-350),
        -110,
        10_000n,
        t0 + 10_000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        1,
      ),
    ).toBe(0);
    expect(
      store.appendLeg(
        "C001",
        2n,
        889598,
        key17410,
        asLineHundredths(-350),
        -110,
        15_000n,
        t0 + 20_000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        1,
      ),
    ).toBe(1);
    // rowIndexB: 2 follows at +10,000ms after rowIndexA: 1 (and +20,000ms after rowIndexA: 0)
    expect(
      store.appendLeg(
        "C002",
        3n,
        889598,
        key17410,
        asLineHundredths(-350),
        -110,
        10_000n,
        t0 + 30_000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        1,
      ),
    ).toBe(2);
    // Separate C002-only event (catalogEvents=2)
    expect(
      store.appendLeg(
        "C002",
        4n,
        889599,
        key17410,
        asLineHundredths(-150),
        -110,
        10_000n,
        t0 + 40_000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        0,
      ),
    ).toBe(3);

    const res = evaluateColumnarPairwiseCrossRef(store, "C001", "C002");
    expect(res.totalWagersA).toBe(2);
    expect(res.totalWagersB).toBe(2);
    expect(res.catalogDistinctEvents).toBe(2);
    expect(res.sharedEventsCount).toBe(1);
    expect(res.sameSideCount).toBe(1);
    expect(res.pregameFollowsAtoB).toBe(1);
    expect(res.pregameFollowsBtoA).toBe(0);
    expect(res.minSameSideLagMsU32).toBe(10_000);
    expect(res.avgSameSideLagMsU32).toBe(10_000);
    expect(res.overlapStore.length).toBe(1);
    expect(res.overlapStore.lagMsU32Col[0]).toBe(10_000);
    expect(res.overlaps).toEqual([
      {
        canonicalRot20: 889598,
        packedComboKey15: key17410,
        rowIndexA: 1,
        rowIndexB: 2,
        lagMsU32: 10_000,
        overlapKind: OVERLAP_SAME_SIDE,
        regimeMask2: REGIME_PREGAME,
        initiatorCode: "CUSTOMER_A",
        lineSigMatch: true,
        broadcastSurgeSuppressed: false,
      },
    ]);
  });

  test("deduplicates B-to-A follower binds and avoids false reverse follow when A led first", () => {
    const store = new PairwiseWagerColumnStore(8);
    const key = packSubSportComboKey15(1, 0, 0, 0);
    const t0 = 1_763_262_050_000;

    // Rot 501: B leads twice (t+1000, t+2500), A follows once (t+4000) -> 1 B->A at 1500ms
    store.appendLeg(
      "CUST_B",
      1n,
      501,
      key,
      asLineHundredths(-250),
      -110,
      10_000n,
      t0 + 1_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "CUST_B",
      2n,
      501,
      key,
      asLineHundredths(-250),
      -110,
      10_000n,
      t0 + 2_500,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "CUST_A",
      3n,
      501,
      key,
      asLineHundredths(-250),
      -110,
      10_000n,
      t0 + 4_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );

    // Rot 502: A leads (t+10000), B follows (t+12000), then A tops up (t+13500).
    // A0 preceded B0, so A1 must NOT count as B->A follow!
    store.appendLeg(
      "CUST_A",
      4n,
      502,
      key,
      asLineHundredths(-400),
      -110,
      10_000n,
      t0 + 10_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );
    store.appendLeg(
      "CUST_B",
      5n,
      502,
      key,
      asLineHundredths(-400),
      -110,
      10_000n,
      t0 + 12_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );
    store.appendLeg(
      "CUST_A",
      6n,
      502,
      key,
      asLineHundredths(-400),
      -110,
      10_000n,
      t0 + 13_500,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );

    const res = evaluateColumnarPairwiseCrossRef(store, "CUST_A", "CUST_B");
    expect(res.sameSideCount).toBe(2);
    expect(res.pregameApiBotFollowsBtoA).toBe(1);
    expect(res.pregameApiBotFollowsAtoB).toBe(1);
    expect(res.minSameSideLagMsU32).toBe(1_500);
    expect(res.avgSameSideLagMsU32).toBe(1_750);
    expect(res.overlapStore.length).toBe(2);
  });

  test("detects LIVE_IN_PLAY <= 1,500ms follows across half-point tick moves and suppresses broadcast surges (> 8 accounts)", () => {
    const store = new PairwiseWagerColumnStore(32);
    const liveKey = packSubSportComboKey15(3, LIVE_WAGER_TYPE_CODE3, 0, 0);
    const baseMs = 1_763_262_000_000;

    for (let i = 0; i < 3; i++) {
      const rot = 9100 + i;
      const t = baseMs + i * 10_000;
      store.appendLeg(
        "CUST_A",
        BigInt(1000 + i),
        rot,
        liveKey,
        asLineHundredths(-350),
        -110,
        50_000n,
        t,
        SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
        1,
        0,
        2,
      );
      store.appendLeg(
        "CUST_B",
        BigInt(2000 + i),
        rot,
        liveKey,
        asLineHundredths(-450),
        -110,
        50_000n,
        t + 850,
        SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
        1,
        0,
        2,
      );
    }

    // Broadcast-surge event with 11 distinct accounts within 3,000ms -> suppressed
    store.appendLeg(
      "CUST_A",
      1099n,
      9500,
      liveKey,
      asLineHundredths(-250),
      -110,
      50_000n,
      baseMs + 50_000,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      1,
      0,
      11,
    );
    store.appendLeg(
      "CUST_B",
      2099n,
      9500,
      liveKey,
      asLineHundredths(-250),
      -110,
      50_000n,
      baseMs + 50_600,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      1,
      0,
      11,
    );

    const res = evaluateColumnarPairwiseCrossRef(store, "CUST_A", "CUST_B");
    expect(res.sameSideCount).toBe(4);
    expect(res.suppressedBroadcastSurgeCount).toBe(1);
    expect(res.liveBotFollowsAtoB).toBe(3);
    expect(res.liveBotFollowsBtoA).toBe(0);
    expect(res.customerALeadShareBps).toBe(parseAsBasisPoints(10_000, true));
    expect(res.inferredRoleB).toBe("COPY_FOLLOWER");
    expect(res.overlaps[0]?.regimeMask2).toBe(REGIME_LIVE_IN_PLAY);
    expect(res.overlaps[0]?.lineSigMatch).toBe(true);
    expect(res.overlaps[0]?.lagMsU32).toBe(850);
    expect(res.overlaps[3]?.broadcastSurgeSuppressed).toBe(true);
  });

  test("enforces PREGAME line-sensitivity, separates OPPOSITE_SIDE / DIFFERENT_MARKET, and computes true catalog bAbsentParticipationBps", () => {
    const store = new PairwiseWagerColumnStore(32);
    const pregameSpreadKey = packSubSportComboKey15(1, 0, 0, 0);
    const pregameTotalKey = packSubSportComboKey15(1, 0, 0, 1);
    const baseMs = 1_763_262_100_000;

    store.appendLeg(
      "ALPHA",
      1n,
      101,
      pregameSpreadKey,
      asLineHundredths(-300),
      -110,
      10_000n,
      baseMs,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "BETA",
      2n,
      101,
      pregameSpreadKey,
      asLineHundredths(-300),
      -110,
      10_000n,
      baseMs + 2_400,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );

    store.appendLeg(
      "ALPHA",
      3n,
      102,
      pregameSpreadKey,
      asLineHundredths(-700),
      -110,
      10_000n,
      baseMs + 20_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "BETA",
      4n,
      102,
      pregameSpreadKey,
      asLineHundredths(700),
      -110,
      10_000n,
      baseMs + 30_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );

    store.appendLeg(
      "ALPHA",
      5n,
      103,
      pregameSpreadKey,
      asLineHundredths(-250),
      -110,
      10_000n,
      baseMs + 40_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "BETA",
      6n,
      103,
      pregameTotalKey,
      asLineHundredths(4450),
      -110,
      10_000n,
      baseMs + 45_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );

    store.appendLeg(
      "BETA",
      7n,
      104,
      pregameSpreadKey,
      asLineHundredths(-150),
      -110,
      10_000n,
      baseMs + 50_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    for (let r = 105; r <= 110; r++) {
      store.appendLeg(
        `OTHER_${r}`,
        BigInt(r),
        r,
        pregameSpreadKey,
        asLineHundredths(-110),
        -110,
        10_000n,
        baseMs + r * 1000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        0,
      );
    }

    const res = evaluateColumnarPairwiseCrossRef(store, "ALPHA", "BETA");
    expect(res.catalogDistinctEvents).toBe(10);
    expect(res.distinctEventsA).toBe(3);
    expect(res.distinctEventsB).toBe(4);
    expect(res.sharedEventsCount).toBe(3);
    expect(res.sameSideCount).toBe(1);
    expect(res.oppositeSideCount).toBe(1);
    expect(res.differentMarketCount).toBe(1);
    expect(res.pregameApiBotFollowsAtoB).toBe(1);
    expect(res.pregameFollowsAtoB).toBe(1);
    expect(res.customerALeadShareBps).toBe(parseAsBasisPoints(10_000, true));
    expect(res.bPresentParticipationBps).toBe(parseAsBasisPoints(10_000, true));
    expect(res.bAbsentParticipationBps).toBe(parseAsBasisPoints(1_429, true));
    expect(res.liftRatioBps).toBe(parseAsBasisPoints(8_571, true));
    expect(res.overlaps.map((o) => o.overlapKind)).toEqual([
      OVERLAP_SAME_SIDE,
      OVERLAP_OPPOSITE_SIDE,
      OVERLAP_DIFFERENT_MARKET,
    ]);
    expect(res.overlaps[0]?.regimeMask2).toBe(REGIME_PREGAME);
  });

  test("supports multi-bridge stores and bridgeFilter isolation", () => {
    const store = new PairwiseWagerColumnStore(8);
    const pregameKey = packSubSportComboKey15(1, 0, 0, 0);
    const liveKey = packSubSportComboKey15(1, LIVE_WAGER_TYPE_CODE3, 0, 0);
    const baseMs = 1_763_262_200_000;

    store.appendLeg(
      "A1",
      1n,
      201,
      pregameKey,
      asLineHundredths(-300),
      -110,
      10_000n,
      baseMs,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "B1",
      2n,
      201,
      pregameKey,
      asLineHundredths(-300),
      -110,
      10_000n,
      baseMs + 2_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "A1",
      3n,
      9202,
      liveKey,
      asLineHundredths(-150),
      -110,
      10_000n,
      baseMs + 5_000,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      0,
    );
    store.appendLeg(
      "B1",
      4n,
      9202,
      liveKey,
      asLineHundredths(-250),
      -110,
      10_000n,
      baseMs + 5_500,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      0,
    );

    const all = evaluateColumnarPairwiseCrossRef(store, "A1", "B1", {
      bridgeFilter: "ALL",
    });
    expect(all.sharedEventsCount).toBe(2);
    expect(all.sameSideCount).toBe(2);

    const onlyF402 = evaluateColumnarPairwiseCrossRef(store, "A1", "B1", {
      bridgeFilter: SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
    });
    expect(onlyF402.sharedEventsCount).toBe(1);
    expect(onlyF402.pregameApiBotFollowsAtoB).toBe(1);

    const onlyGsLive = evaluateColumnarPairwiseCrossRef(store, "A1", "B1", {
      bridgeFilter: SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
    });
    expect(onlyGsLive.sharedEventsCount).toBe(1);
    expect(onlyGsLive.liveBotFollowsAtoB).toBe(1);
  });
});

describe("sportsdesk-fraud cross-ref governance & R2 lineage envelope", () => {
  test("assertPairwiseCrossRefLivePreflight enforces ERR_OPS_LOCAL_JSON_FORBIDDEN, retired keys, token bleed, and R2 creds", () => {
    const okEnv = makeLiveEnv();

    for (const badArgv of [
      ["C001", "C002", "--input", "live.json"],
      ["C001", "C002", "--input=foo.bin"],
      ["C001", "C002", "--file", "/tmp/wagers.json"],
      ["C001", "C002", "tests/fixtures/fraud/live-wagers.json"],
      ["C001", "C002", "scratch/wagers.sqlite"],
      ["C001", "C002", "scratch/spine.dodbin"],
    ]) {
      expect(() => assertPairwiseCrossRefLivePreflight(badArgv, okEnv)).toThrow(
        /ERR_OPS_LOCAL_JSON_FORBIDDEN/,
      );
    }

    for (const retiredKey of RETIRED_ENV_KEYS) {
      expect(() =>
        assertPairwiseCrossRefLivePreflight(["C001", "C002"], {
          ...okEnv,
          [retiredKey]: "1",
        }),
      ).toThrow(`ERR_DOD_LEGACY_FALLBACK_REMOVED: ${retiredKey}`);
    }

    expect(() =>
      assertPairwiseCrossRefLivePreflight(["C001", "C002"], {
        ...okEnv,
        CLOUDFLARE_R2_API_TOKEN: "r2",
        CLOUDFLARE_API_TOKEN: "cf",
      }),
    ).toThrow(/ERR_CF_TOKEN_BLEED_10000/);

    const missingR2 = makeLiveEnv();
    delete missingR2.R2_ACCESS_KEY_ID;
    expect(() =>
      assertPairwiseCrossRefLivePreflight(["C001", "C002"], missingR2),
    ).toThrow(/ERR_CF_R2_CREDENTIALS_MISSING/);

    expect(() =>
      assertPairwiseCrossRefLivePreflight(["C001", "C002"], okEnv),
    ).not.toThrow();
  });

  test("executePairwiseCrossRefFromR2 hydrates in-memory R2 manifests + SoA chunk and stamps full 9-field R2 lineage envelope", async () => {
    const store = new PairwiseWagerColumnStore(8);
    const key = packSubSportComboKey15(1, 0, 0, 0);
    const baseMs = 1_763_262_300_000;

    store.appendLeg(
      "C001",
      1n,
      889598,
      key,
      asLineHundredths(-350),
      -110,
      20_000n,
      baseMs + 10_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "C001",
      2n,
      889598,
      key,
      asLineHundredths(-350),
      -110,
      30_000n,
      baseMs + 20_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "C002",
      3n,
      889598,
      key,
      asLineHundredths(-350),
      -110,
      25_000n,
      baseMs + 30_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );

    const chunkBytes = encodePairwiseSoAChunk(store);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(chunkBytes);
    const chunkSha256 = hasher.digest("hex");
    const chunkKey = `chunks/wagers-by-state/${chunkSha256}.bin`;

    const r2Objects = new Map<string, Uint8Array>([
      [
        WAGERS_BY_STATE_MANIFEST_KEY,
        new TextEncoder().encode(
          JSON.stringify({
            domain: "[Ops & Governance]",
            sink_id: "wagers-by-state",
            r2_bucket: R2_BUCKET,
            generation_u32: 19,
            merkle_root_sha256: chunkSha256,
            watermark_cursor: "wm-19:3",
            data_window_max_epoch_ms: baseMs + 30_000,
            r2_published_at_epoch_ms: baseMs + 31_000,
            chunk_key: chunkKey,
            circuit_state: "CLOSED",
          }),
        ),
      ],
      [
        SYNDICATE_RINGS_MANIFEST_KEY,
        new TextEncoder().encode(
          JSON.stringify({
            domain: "[DOD Spine]",
            r2_bucket: R2_BUCKET,
            manifest_key: SYNDICATE_RINGS_MANIFEST_KEY,
            generation_u32: 7,
            spine_generation_u32: 19,
            merkle_root_sha256: "f".repeat(64),
            r2_published_at_epoch_ms: baseMs + 31_500,
            active_edge_count_u32: 4,
            ring_count_u32: 1,
            rings: [],
          }),
        ),
      ],
      [chunkKey, chunkBytes],
    ]);

    const payload = await executePairwiseCrossRefFromR2({
      r2: createInMemoryR2Reader(r2Objects),
      customerA: "C001",
      customerB: "C002",
    });

    // All 9 mandatory R2 Lineage Envelope fields
    expect(payload.domain).toBe("[Ops & Governance]");
    expect(payload.sink_id).toBe("wagers-by-state");
    expect(payload.r2_bucket).toBe(R2_BUCKET);
    expect(payload.generation_u32).toBe(19);
    expect(payload.merkle_root_sha256).toBe(chunkSha256);
    expect(payload.watermark_cursor).toBe("wm-19:3");
    expect(payload.data_window_max_epoch_ms).toBe(baseMs + 30_000);
    expect(payload.r2_published_at_epoch_ms).toBe(baseMs + 31_000);
    expect(payload.circuit_state).toBe("CLOSED");
    expect(payload.unresolved_gap_cents).toBe("0");

    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe("cross-ref");
    expect(payload.manifests.wagersByState.key).toBe(
      WAGERS_BY_STATE_MANIFEST_KEY,
    );
    expect(payload.manifests.syndicateRings.key).toBe(
      SYNDICATE_RINGS_MANIFEST_KEY,
    );
    expect(payload.manifests.syndicateRings.ring_count_u32).toBe(1);

    expect(payload.analysis.sameSideCount).toBe(1);
    expect(payload.analysis.pregameFollowsAtoB).toBe(1);
    expect(payload.analysis.minSameSideLagMsU32).toBe(10_000);
    expect(payload.analysis.overlaps[0]?.lagMsU32).toBe(10_000);
    expect("overlapStore" in payload.analysis).toBe(false);
    expect("sources" in payload).toBe(false);
  });

  test("bun x --no-install sportsdesk-fraud cross-ref enforces --help, ERR_OPS_LOCAL_JSON_FORBIDDEN (exit 78), and preflight gates", () => {
    const helpProc = Bun.spawnSync(
      [
        process.execPath,
        "x",
        "--no-install",
        "sportsdesk-fraud",
        "cross-ref",
        "--help",
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(helpProc.exitCode).toBe(0);
    expect(helpProc.stdout.toString()).toContain("sportsdesk-fraud cross-ref");

    const localJsonProc = Bun.spawnSync(
      [
        process.execPath,
        "x",
        "--no-install",
        "sportsdesk-fraud",
        "cross-ref",
        "C001",
        "C002",
        "--input",
        "live.json",
        "--json",
      ],
      {
        cwd: ROOT,
        env: makeLiveEnv(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(localJsonProc.exitCode).toBe(78);
    expect(localJsonProc.stderr.toString()).toContain(
      "ERR_OPS_LOCAL_JSON_FORBIDDEN",
    );

    const bleedEnv = {
      ...makeLiveEnv(),
      CLOUDFLARE_R2_API_TOKEN: "r2",
      CLOUDFLARE_API_TOKEN: "cf",
    };
    const bleedProc = Bun.spawnSync(
      [
        process.execPath,
        "x",
        "--no-install",
        "sportsdesk-fraud",
        "cross-ref",
        "C001",
        "C002",
        "--json",
      ],
      {
        cwd: ROOT,
        env: bleedEnv,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(bleedProc.exitCode).toBe(77);
    expect(bleedProc.stderr.toString()).toContain("ERR_CF_TOKEN_BLEED_10000");
  });
});
