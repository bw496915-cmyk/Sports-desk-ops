import { describe, expect, test } from "bun:test";
import {
  benjaminiHochbergAdjust,
  binomialUpperTailPValue,
  BOT_VALIDATION_SCHEMA_VERSION,
  type BotValidationRawInputs,
  buildSuspectedBotValidationReport,
  computeWilson95Ci,
  createMulberry32Prng,
} from "./f402_bot_validation_reconciliation.ts";
import type { ReportPlayerAnalysisRowRaw } from "./f402_report_player_analysis.ts";

function buildSyntheticValidationInputs(options?: {
  injectSummaryNetDiscrepancyWholeUsd?: number;
}): BotValidationRawInputs {
  const populationSummaryRows: ReportPlayerAnalysisRowRaw[] = [];
  const flaggedDetailRows: ReportPlayerAnalysisRowRaw[] = [];

  // 1. Create 32 flagged accounts (>= 30 required for Deliverable 1 audit):
  // - 4 AYMAN x laythechalk.com accounts with contractual -105 flat price and synchronized NFL/College legs
  for (let i = 1; i <= 4; i++) {
    const cid = `AYM5900${i}`;
    const wagers = 20;
    let netSum = 0;
    let bpCount = 0;
    let bptsCount = 0;
    for (let w = 0; w < wagers; w++) {
      const isWin = w % 2 === 0;
      const risk = 105;
      const toWin = 100;
      const winLose = isWin ? toWin : risk;
      netSum += isWin ? toWin : -risk;
      const beatPrice = w < 15; // 75% raw beat price from -105 vs -110
      const beatPts = w < 4; // 20% beat points
      if (beatPrice) bpCount++;
      if (beatPts) bptsCount++;
      flaggedDetailRows.push({
        CustomerID: `${cid}  `,
        PlayerLogin: cid,
        AgentID: "AYMAN     ",
        AgentLogin: cid,
        SuspectedBot: "Y",
        SuspectedBotType: "0",
        InetTarget: "laythechalk.com",
        BETPOINTS: "-3.5",
        JUICE: "-105.0",
        CLOSELINE: beatPts ? "-4.5 -110" : "-3.5 -110",
        PRICE: beatPrice ? -5 : 0,
        POINTS: beatPts ? -1 : null,
        DESCRIPTION: `Football #${450 + (w % 5)} Bills -3.5 -105 - For Game`,
        DAILYFIGUREDATE:
          w < 10 ? "2026-11-04 00:00:00.000" : "2026-11-10 00:00:00.000",
        POSTEDDATETIME:
          w < 10 ? "2026-11-04 15:00:00.000" : "2026-11-10 15:00:00.000",
        RISK: String(risk),
        TOWIN: String(toWin),
        WINLOSE: String(winLose),
        WAGERSTATUS: isWin ? "W" : "L",
        SPORTSUBTYPE: "NFL                 ",
        PERIODNUMBER: "2",
        TOTALBETS: null,
        BETTERPRICELINES: null,
        BETTERPOINTSLINES: null,
      });
    }
    populationSummaryRows.push({
      CustomerID: `${cid}  `,
      PlayerLogin: cid,
      AgentID: "AYMAN     ",
      AgentLogin: cid,
      SuspectedBot: "Y",
      SuspectedBotType: "0",
      InetTarget: "laythechalk.com",
      PRICE: -5,
      POINTS: -0.5,
      BETTERPRICELINES: bpCount,
      BETTERPOINTSLINES: bptsCount,
      TOTALBETS: wagers,
      WINLOSE: String(
        netSum +
          (i === 1 ? (options?.injectSummaryNetDiscrepancyWholeUsd ?? 0) : 0),
      ),
    });
  }

  // - 8 high-CLV prop/sharp flagged accounts (20 wagers each, 75% beat points + 60% genuine beat price)
  for (let i = 1; i <= 8; i++) {
    const cid = `SHARP_${i}`;
    const wagers = 20;
    let netSum = 0;
    let bpCount = 0;
    let bptsCount = 0;
    for (let w = 0; w < wagers; w++) {
      const isWin = w < 13;
      const risk = 550;
      const toWin = 500;
      const winLose = isWin ? toWin : risk;
      netSum += isWin ? toWin : -risk;
      const beatPrice = w < 12;
      const beatPts = w < 15;
      if (beatPrice) bpCount++;
      if (beatPts) bptsCount++;
      flaggedDetailRows.push({
        CustomerID: cid,
        PlayerLogin: cid,
        AgentID: i <= 4 ? "ADAM" : "CAKEJAKE",
        AgentLogin: cid,
        SuspectedBot: "Y",
        SuspectedBotType: i <= 2 ? "3" : "0",
        InetTarget: i <= 4 ? "89Blue.com" : "vip365.com",
        BETPOINTS: "22.5",
        JUICE: "-110.0",
        CLOSELINE: "24.5 -125",
        PRICE: beatPrice ? -15 : 0,
        POINTS: beatPts ? -2 : null,
        DESCRIPTION: `Basketball #${500 + w} Player Points O 22.5 -110 - For Game`,
        DAILYFIGUREDATE:
          w < 10 ? "2026-11-05 00:00:00.000" : "2026-11-12 00:00:00.000",
        POSTEDDATETIME:
          w < 10
            ? `2026-11-05 18:10:${String(w).padStart(2, "0")}.000`
            : `2026-11-12 18:10:${String(w - 10).padStart(2, "0")}.000`,
        RISK: String(risk),
        TOWIN: String(toWin),
        WINLOSE: String(winLose),
        WAGERSTATUS: isWin ? "W" : "L",
        SPORTSUBTYPE: "NBAPlayerPro",
        PERIODNUMBER: "0",
        TOTALBETS: null,
        BETTERPRICELINES: null,
        BETTERPOINTSLINES: null,
      });
    }
    populationSummaryRows.push({
      CustomerID: cid,
      PlayerLogin: cid,
      AgentID: i <= 4 ? "ADAM" : "CAKEJAKE",
      AgentLogin: cid,
      SuspectedBot: "Y",
      SuspectedBotType: i <= 2 ? "3" : "0",
      InetTarget: i <= 4 ? "89Blue.com" : "vip365.com",
      PRICE: -12,
      POINTS: -1.8,
      BETTERPRICELINES: bpCount,
      BETTERPOINTSLINES: bptsCount,
      TOTALBETS: wagers,
      WINLOSE: String(netSum),
    });
  }

  // - 20 low-volume flagged accounts (including RY345 with 1 wager at 1/1 = 100% raw beat price)
  for (let i = 1; i <= 20; i++) {
    const cid = i === 1 ? "RY345" : `MICRO_BOT_${i}`;
    const wagers = i <= 9 ? 1 : 8;
    let netSum = 0;
    let bpCount = 0;
    let bptsCount = 0;
    for (let w = 0; w < wagers; w++) {
      const isWin = w === 0;
      const risk = 100;
      const toWin = 220;
      const winLose = isWin ? toWin : risk;
      netSum += isWin ? toWin : -risk;
      const beatPrice = w === 0 || (i > 9 && w === 1);
      const beatPts = i > 9 && w < 3;
      if (beatPrice) bpCount++;
      if (beatPts) bptsCount++;
      flaggedDetailRows.push({
        CustomerID: cid,
        PlayerLogin: cid,
        AgentID: `OFFICE_${i}`,
        AgentLogin: cid,
        SuspectedBot: "Y",
        SuspectedBotType: "0",
        InetTarget: i === 1 ? "hulkwager.com" : "Fire22.com",
        BETPOINTS: beatPts ? "-2.5" : null,
        JUICE: "+220.0",
        CLOSELINE: beatPts ? "-3.5 +195" : "+195",
        PRICE: beatPrice ? -25 : 0,
        POINTS: beatPts ? -1 : null,
        DESCRIPTION: `Football #${800 + i} Prop +220 - For Game`,
        DAILYFIGUREDATE: "2026-11-06 00:00:00.000",
        POSTEDDATETIME: "2026-11-06 12:00:00.000",
        RISK: String(risk),
        TOWIN: String(toWin),
        WINLOSE: String(winLose),
        WAGERSTATUS: isWin ? "W" : "L",
        SPORTSUBTYPE: "NFLGAMEPROP",
        PERIODNUMBER: "0",
        TOTALBETS: null,
        BETTERPRICELINES: null,
        BETTERPOINTSLINES: null,
      });
    }
    populationSummaryRows.push({
      CustomerID: cid,
      PlayerLogin: cid,
      AgentID: `OFFICE_${i}`,
      AgentLogin: cid,
      SuspectedBot: "Y",
      SuspectedBotType: "0",
      InetTarget: i === 1 ? "hulkwager.com" : "Fire22.com",
      PRICE: -10,
      POINTS: i <= 9 ? null : -0.9,
      BETTERPRICELINES: bpCount,
      BETTERPOINTSLINES: bptsCount,
      TOTALBETS: wagers,
      WINLOSE: String(netSum),
    });
  }

  // 2. Add 2 non-flagged AYMAN active controls with the same -105 flat-price deal (AYM59002, AYM59006)
  populationSummaryRows.push(
    {
      CustomerID: "AYM59002",
      PlayerLogin: "AYM59002",
      AgentID: "AYMAN",
      AgentLogin: "AYM59002",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "laythechalk.com",
      PRICE: -26.86,
      POINTS: -0.62,
      BETTERPRICELINES: 12,
      BETTERPOINTSLINES: 4,
      TOTALBETS: 17,
      WINLOSE: "1525",
    },
    {
      CustomerID: "AYM59006",
      PlayerLogin: "AYM59006",
      AgentID: "AYMAN",
      AgentLogin: "AYM59006",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "laythechalk.com",
      PRICE: -26.42,
      POINTS: -1.1,
      BETTERPRICELINES: 19,
      BETTERPOINTSLINES: 5,
      TOTALBETS: 23,
      WINLOSE: "1005",
    },
  );

  // 3. Add 300 non-flagged recreational population accounts (low beat-points and beat-price rates ~12%)
  for (let i = 1; i <= 300; i++) {
    const cid = `REC_POP_${i}`;
    const totalBets = (i % 4) + 1;
    const bp = i % 7 === 0 ? 1 : 0;
    const bpts = i % 8 === 0 ? 1 : 0;
    populationSummaryRows.push({
      CustomerID: cid,
      PlayerLogin: cid,
      AgentID: i % 2 === 0 ? "ADAM" : "CAKEJAKE",
      AgentLogin: cid,
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: i % 2 === 0 ? "89Blue.com" : "vip365.com",
      PRICE: 1.5,
      POINTS: 0.2,
      BETTERPRICELINES: bp,
      BETTERPOINTSLINES: bpts,
      TOTALBETS: totalBets,
      WINLOSE: String((i % 3 === 0 ? 1 : -1) * totalBets * 25),
    });
  }

  return {
    asOf: "2026-11-14",
    classifierVersion: "v1.0.0-test",
    temporalSplitDate: "2026-11-07",
    permutationCount: 400,
    randomSeed: 402202611,
    inputShas: {
      playerAnalysisAll: {
        path: "synthetic/player-analysis-all.json",
        sha256: "a".repeat(64),
      },
      suspectedBotsDetail: {
        path: "synthetic/suspected-bots-detail.json",
        sha256: "b".repeat(64),
      },
    },
    populationSummaryRows,
    flaggedDetailRows,
    rawTicketLedgerRows: [
      {
        CustomerID: "SHARP_1",
        TicketNumber: "1079066257",
        WagerNumber: 1,
        ItemNumber: 1,
        WagerStatus: "W",
        Outcome: "WIN",
        AmountWagered: 55000, // $550.00 in cents vs RISK="550" whole USD
        ToWinAmount: 50000,
        AmountWon: 50000,
        AmountLost: 0,
        AcceptedDateTime: "2026-11-05 18:10:00.000",
        FinalMoney: null,
        WagerType: "M",
        TicketWriter: "GSBUILDER",
        Description: "Basketball #500 Player Points O 22.5 -110 - For Game",
      },
      {
        CustomerID: "SHARP_1",
        TicketNumber: "1078859210",
        WagerNumber: 1,
        ItemNumber: 1,
        WagerStatus: "L",
        Outcome: "LOSS",
        AmountWagered: 54950, // $549.50 in cents -> rounds half-up to RISK="550" whole USD
        ToWinAmount: 50000,
        AmountWon: 0,
        AmountLost: 54950,
        AcceptedDateTime: "2026-11-12 18:10:00.000",
        FinalMoney: null,
        WagerType: "M",
        TicketWriter: "GSLIVE",
        Description: "Basketball #510 Player Points O 22.5 -110 - For Game",
      },
    ],
    accountProfiles: {
      AYM59001: {
        Login: "AYM59001",
        AgentID: "AYMAN",
        SuspectedBot: "Y",
        SuspectedBotType: 0,
        BasketballFlatPrice: -105,
        FootballFlatPrice: -105,
        WagerLimit: 0,
        ConfirmationDelay: 0,
        WiseLineMovementWeight: 1,
        InetTarget: "laythechalk.com",
      },
    },
  };
}

describe("f402_bot_validation_reconciliation primitives", () => {
  test("computeWilson95Ci bounds point estimate and handles n=0 or extreme proportions", () => {
    const empty = computeWilson95Ci(0, 0);
    expect(empty.pointEstimate).toBe(0);
    expect(empty.lower95).toBe(0);
    expect(empty.upper95).toBe(0);

    const zeroOfNine = computeWilson95Ci(0, 9);
    expect(zeroOfNine.pointEstimate).toBe(0);
    expect(zeroOfNine.lower95).toBe(0);
    expect(zeroOfNine.upper95).toBeGreaterThan(0.25);
    expect(zeroOfNine.upper95).toBeLessThan(0.35);

    const eighteenOf53 = computeWilson95Ci(18, 53);
    expect(eighteenOf53.pointEstimate).toBeCloseTo(0.3396, 4);
    expect(eighteenOf53.lower95).toBeLessThan(eighteenOf53.pointEstimate);
    expect(eighteenOf53.upper95).toBeGreaterThan(eighteenOf53.pointEstimate);
  });

  test("createMulberry32Prng is deterministic for identical seeds", () => {
    const rngA = createMulberry32Prng(402202611);
    const rngB = createMulberry32Prng(402202611);
    const seqA = Array.from({ length: 10 }, () => rngA());
    const seqB = Array.from({ length: 10 }, () => rngB());
    expect(seqA).toEqual(seqB);
  });

  test("binomialUpperTailPValue & benjaminiHochbergAdjust control monotone FDR q-values", () => {
    const pExtreme = binomialUpperTailPValue(20, 25, 0.2);
    expect(pExtreme).toBeLessThan(1e-7);

    const pNull = binomialUpperTailPValue(2, 10, 0.2);
    expect(pNull).toBeGreaterThan(0.5);

    const rawPs = [0.0001, 0.004, 0.03, 0.25, 0.8];
    const qVals = benjaminiHochbergAdjust(rawPs);
    expect(qVals).toHaveLength(5);
    expect(qVals[0]!).toBeLessThanOrEqual(qVals[1]!);
    expect(qVals[1]!).toBeLessThanOrEqual(qVals[2]!);
    expect(qVals[2]!).toBeLessThanOrEqual(qVals[3]!);
    expect(qVals[3]!).toBeLessThanOrEqual(qVals[4]!);
  });
});

describe("buildSuspectedBotValidationReport six forensic deliverables & acceptance scorecard", () => {
  test("produces all 6 deliverables, passes all acceptance criteria (a)-(f), and enforces penny-exact reconciliation", () => {
    const inputs = buildSyntheticValidationInputs();
    const report = buildSuspectedBotValidationReport(inputs);

    expect(report.schema_version).toBe(BOT_VALIDATION_SCHEMA_VERSION);
    expect(report.as_of).toBe("2026-11-14");
    expect(report.classifier_version).toBe("v1.0.0-test");
    expect(report.provenance.endpoint).toBe(
      "/cloud/api/Manager/getReportPlayerAnalysis",
    );
    expect(report.provenance.query_sha).toHaveLength(64);

    // Deliverable 1: Ground-truth audit & downgrade to vendor_flag
    const d1 = report.deliverable_1_ground_truth_audit;
    expect(d1.auditedAccountCount).toBe(32);
    expect(d1.auditedAccountCount).toBeGreaterThanOrEqual(
      d1.minimumRequiredAuditedAccounts,
    );
    expect(d1.externalLabeledBotPositivesExist).toBe(false);
    expect(d1.trueAutomationPrecisionStatus).toBe(
      "UNMEASURABLE_NO_EXTERNAL_BOT_GROUND_TRUTH",
    );
    expect(d1.terminologyPolicy).toBe(
      "ALL_SUSPECTED_BOT_CLAIMS_DOWNGRADED_TO_VENDOR_FLAG",
    );
    expect(d1.rawLedgerJoinSummary.exactTimestampMatchedRows).toBe(2);
    expect(d1.rawLedgerJoinSummary.sqlHalfUpSubDollarRoundingCases).toBe(1);

    const microStratum = d1.byVolumeStratum.find(
      (s) => s.stratum === "MICRO_1_TO_2_WAGERS",
    );
    expect(microStratum).toBeDefined();
    expect(microStratum?.accountCount).toBe(9);
    expect(microStratum?.strictPositiveCount).toBe(0);
    expect(microStratum?.broadPositiveCount).toBe(0);

    // Deliverable 2: Classifier description & temporal holdout evaluation
    const d2 = report.deliverable_2_classifier_description;
    expect(d2.temporalHoldoutEvaluation.prAuc).toBeGreaterThan(
      d2.temporalHoldoutEvaluation.randomBaselinePrAuc,
    );
    expect(d2.temporalHoldoutEvaluation.rocAuc).toBeGreaterThan(0.5);
    expect(d2.temporalHoldoutEvaluation.thresholdSweep.length).toBeGreaterThan(
      0,
    );

    // Deliverable 3: Permutation null model & matched control + AYMAN decomposition
    const d3 = report.deliverable_3_null_model_and_matched_control;
    expect(
      d3.permutationNull.metrics.aggBeatPointsRate
        ?.sitsAtOrBeyond95thPercentile,
    ).toBe(true);
    expect(d3.matchedControlCohort.matchedPairCount).toBe(32);
    expect(
      d3.matchedControlCohort.aymanLaythechalkDecomposition
        .rawFlaggedBeatPriceRate,
    ).toBeCloseTo(0.75, 2);
    expect(
      d3.matchedControlCohort.aymanLaythechalkDecomposition
        .unflaggedAymanControlBeatPriceRate,
    ).toBeCloseTo(0.775, 3);
    expect(
      d3.matchedControlCohort.aymanLaythechalkDecomposition
        .withinOfficeBeatPriceDifference,
    ).toBeLessThan(0);

    // Deliverable 4: Benjamini-Hochberg FDR & Empirical Bayes Beta-Binomial shrinkage
    const d4 = report.deliverable_4_fdr_and_shrinkage;
    expect(d4.survivingFdrQ05Count).toBeGreaterThan(0);
    expect(d4.empiricalBayesPrior.singleWagerShrinkageExample.customerId).toBe(
      "RY345",
    );
    expect(
      d4.empiricalBayesPrior.singleWagerShrinkageExample.rawBeatPriceRate,
    ).toBe(1);
    expect(
      d4.empiricalBayesPrior.singleWagerShrinkageExample.shrunkBeatPriceRate,
    ).toBeLessThan(0.3);

    // Deliverable 5: Penny-exact multi-level reconciliation & per-cell provenance
    const d5 = report.deliverable_5_reconciliation;
    expect(d5.allLevelsReconciledToPenny).toBe(true);
    expect(d5.maxDiscrepancyCents).toBe(0);
    expect(d5.levelChecks).toHaveLength(10);
    for (const check of d5.levelChecks) {
      expect(check.matchesParentToPenny).toBe(true);
      expect(check.discrepancyCents).toBe(0);
    }
    expect(d5.tables.byOffice.rows[0]?.provenance.query_sha).toBe(
      report.provenance.query_sha,
    );

    // Deliverable 6: Acceptance scorecard all passed & deterministic reproducibility
    expect(report.acceptance_scorecard.allCriteriaPassed).toBe(true);

    const reportSecondRun = buildSuspectedBotValidationReport(inputs);
    expect(reportSecondRun.provenance.query_sha).toBe(
      report.provenance.query_sha,
    );
    expect(reportSecondRun.acceptance_scorecard).toEqual(
      report.acceptance_scorecard,
    );
  });

  test("reconciliation gate detects an injected $18.49 (1,849-unit) discrepancy and fails criterion B", () => {
    const brokenInputs = buildSyntheticValidationInputs({
      injectSummaryNetDiscrepancyWholeUsd: 1849,
    });
    const report = buildSuspectedBotValidationReport(brokenInputs);

    expect(report.deliverable_5_reconciliation.allLevelsReconciledToPenny).toBe(
      false,
    );
    expect(
      report.deliverable_5_reconciliation.maxDiscrepancyCents,
    ).toBeGreaterThan(0);
    expect(
      report.acceptance_scorecard.criterionB_officeAndSkinReconcileToPenny
        .passed,
    ).toBe(false);
    expect(report.acceptance_scorecard.allCriteriaPassed).toBe(false);
  });
});
