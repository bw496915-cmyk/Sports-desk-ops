#!/usr/bin/env bun
/**
 * End-to-End Suspected-Bot Cohort Validation & Reconciliation CLI
 *
 * Reproduces every metric from raw inputs up:
 *   1. Full population summary (`reportType=1`, 6,228 accounts: 53 flagged + 6,175 non-flagged)
 *   2. Per-wager sharp-line & CLV ledger (`reportType=2, lineType=1`, 1,560 detail rows)
 *   3. Settled ticket ledger (`getGradedWagerByCustomer`, TicketNumber/WagerNumber/ItemNumber/AmountWagered in cents)
 *   4. Account configuration & risk-posture logs (`getInfoPlayer`, FlatPrice/WagerLimit/ConfirmationDelay)
 *
 * Usage:
 *   bun run analyze:suspected-bots --as-of 2026-11-14 --classifier v1.0.0 [--out scratch/suspected-bots-validation-report.json]
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type AccountProfileConfigSnapshot,
  buildSuspectedBotValidationReport,
  type CustomerHistoricalLedgerTenure,
  type RawPerWagerLedgerRow,
  type SuspectedBotValidationReport,
} from "../lib/f402_bot_validation_reconciliation.ts";

interface CliArgs {
  readonly asOf: string;
  readonly classifierVersion: string;
  readonly summaryPath: string;
  readonly detailPath: string;
  readonly bundlePath: string;
  readonly outPath: string;
  readonly permutationCount: number;
  readonly randomSeed: number;
  readonly temporalSplitDate: string;
  readonly quiet: boolean;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  let asOf = "2026-11-14";
  let classifierVersion = "v1.0.0";
  let summaryPath = "scratch/f402-player-analysis-all.json";
  let detailPath = "scratch/f402-suspected-bots-detail.json";
  let bundlePath = "scratch/f402-suspected-bots-raw-ledger-bundle.json";
  let outPath = "scratch/suspected-bots-validation-report.json";
  let permutationCount = 2000;
  let randomSeed = 402202611;
  let temporalSplitDate = "2026-11-07";
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--as-of" && next) {
      asOf = next;
      i++;
    } else if (
      (arg === "--classifier" || arg === "--classifier-version") &&
      next
    ) {
      classifierVersion = next;
      i++;
    } else if (arg === "--summary-json" && next) {
      summaryPath = next;
      i++;
    } else if (arg === "--detail-json" && next) {
      detailPath = next;
      i++;
    } else if (arg === "--bundle-json" && next) {
      bundlePath = next;
      i++;
    } else if (arg === "--out" && next) {
      outPath = next;
      i++;
    } else if (arg === "--permutations" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) permutationCount = parsed;
      i++;
    } else if (arg === "--seed" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed)) randomSeed = parsed;
      i++;
    } else if (arg === "--split-date" && next) {
      temporalSplitDate = next;
      i++;
    } else if (arg === "--quiet") {
      quiet = true;
    }
  }

  return {
    asOf,
    classifierVersion,
    summaryPath,
    detailPath,
    bundlePath,
    outPath,
    permutationCount,
    randomSeed,
    temporalSplitDate,
    quiet,
  };
}

function sha256Hex(content: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

function extractRawRowsFromJsonPayload(
  parsed: unknown,
): readonly Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed as Record<string, unknown>[];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.detailRows)) {
    return obj.detailRows as Record<string, unknown>[];
  }
  if (Array.isArray(obj.LIST)) {
    return obj.LIST as Record<string, unknown>[];
  }
  if (Array.isArray(obj.rows)) {
    return obj.rows as Record<string, unknown>[];
  }
  if (typeof obj.rawByCustomer === "object" && obj.rawByCustomer !== null) {
    const out: Record<string, unknown>[] = [];
    for (const v of Object.values(
      obj.rawByCustomer as Record<string, unknown>,
    )) {
      if (Array.isArray(v)) {
        for (const r of v) {
          if (typeof r === "object" && r !== null) {
            out.push(r as Record<string, unknown>);
          }
        }
      }
    }
    return out;
  }
  return [];
}

interface RawLedgerBundlePayload {
  readonly inputShas?: Record<string, { path: string; sha256: string }>;
  readonly accountProfiles?: Record<string, AccountProfileConfigSnapshot>;
  readonly rawTicketLedgerForFlagged?: readonly RawPerWagerLedgerRow[];
  readonly customerLedgerTenure?: Record<
    string,
    CustomerHistoricalLedgerTenure
  >;
}

export async function runAnalyzeSuspectedBotsCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<SuspectedBotValidationReport> {
  const args = parseCliArgs(argv);
  const absSummary = resolve(args.summaryPath);
  const absDetail = resolve(args.detailPath);
  const absBundle = resolve(args.bundlePath);
  const absOut = resolve(args.outPath);

  const summaryFile = Bun.file(absSummary);
  const detailFile = Bun.file(absDetail);
  const bundleFile = Bun.file(absBundle);

  if (!(await summaryFile.exists())) {
    throw new Error(
      `Missing population summary input file: ${absSummary}. Run scripts/f402_report_player_analysis_sweep.ts first.`,
    );
  }
  if (!(await detailFile.exists())) {
    throw new Error(
      `Missing per-wager detail input file: ${absDetail}. Run scripts/f402_report_player_analysis_sweep.ts --customers <53_ids> first.`,
    );
  }

  const [summaryText, detailText] = await Promise.all([
    summaryFile.text(),
    detailFile.text(),
  ]);

  const summarySha = sha256Hex(summaryText);
  const detailSha = sha256Hex(detailText);

  const summaryRows = extractRawRowsFromJsonPayload(JSON.parse(summaryText));
  const detailRows = extractRawRowsFromJsonPayload(JSON.parse(detailText));

  let bundle: RawLedgerBundlePayload = {};
  const inputShas: Record<string, { path: string; sha256: string }> = {
    playerAnalysisAll: { path: args.summaryPath, sha256: summarySha },
    suspectedBotsDetail: { path: args.detailPath, sha256: detailSha },
  };

  if (await bundleFile.exists()) {
    const bundleText = await bundleFile.text();
    const bundleSha = sha256Hex(bundleText);
    bundle = JSON.parse(bundleText) as RawLedgerBundlePayload;
    if (bundle.inputShas) {
      for (const [k, v] of Object.entries(bundle.inputShas)) {
        inputShas[k] = v;
      }
    }
    inputShas.rawLedgerBundle = { path: args.bundlePath, sha256: bundleSha };
  }

  const report = buildSuspectedBotValidationReport({
    asOf: args.asOf,
    classifierVersion: args.classifierVersion,
    populationSummaryRows: summaryRows,
    flaggedDetailRows: detailRows,
    ...(bundle.rawTicketLedgerForFlagged !== undefined
      ? { rawTicketLedgerRows: bundle.rawTicketLedgerForFlagged }
      : {}),
    ...(bundle.customerLedgerTenure !== undefined
      ? { customerLedgerTenure: bundle.customerLedgerTenure }
      : {}),
    ...(bundle.accountProfiles !== undefined
      ? { accountProfiles: bundle.accountProfiles }
      : {}),
    inputShas,
    temporalSplitDate: args.temporalSplitDate,
    permutationCount: args.permutationCount,
    randomSeed: args.randomSeed,
  });

  await mkdir(dirname(absOut), { recursive: true });
  await Bun.write(absOut, `${JSON.stringify(report, null, 2)}\n`);

  if (!args.quiet) {
    const sc = report.acceptance_scorecard;
    const gAudit = report.deliverable_1_ground_truth_audit;
    const clf = report.deliverable_2_classifier_description;
    const nullCtrl = report.deliverable_3_null_model_and_matched_control;
    const fdr = report.deliverable_4_fdr_and_shrinkage;
    const rec = report.deliverable_5_reconciliation;

    console.log(
      JSON.stringify(
        {
          schema_version: report.schema_version,
          as_of: report.as_of,
          classifier_version: report.classifier_version,
          output_artifact: args.outPath,
          provenance: report.provenance,
          input_shas: report.input_shas,
          headline_summary: {
            population_accounts: clf.temporalHoldoutEvaluation.populationCount,
            vendor_flagged_accounts: gAudit.auditedAccountCount,
            total_flagged_wagers: rec.cohortTotals.wagerCount,
            total_risk_whole_usd: rec.cohortTotals.riskWholeUsd,
            total_player_net_whole_usd: rec.cohortTotals.playerNetWholeUsd,
            total_player_net_cents: rec.cohortTotals.playerNetCents,
            true_automation_precision_status:
              gAudit.trueAutomationPrecisionStatus,
            terminology_policy: gAudit.terminologyPolicy,
            strict_syndicate_or_scraper_precision_ci95:
              gAudit.strictSyndicateOrScraperAudit.precisionCi95,
            broad_actionable_sharp_or_syndicate_precision_ci95:
              gAudit.broadActionableSharpOrSyndicateAudit.precisionCi95,
            segments: gAudit.bySegment.map((s) => ({
              segment: s.segment,
              accounts: s.accountCount,
              share_pct: s.shareOfFlaggedPct,
              wagers: s.totalWagers,
              net_whole_usd: s.totalPlayerNetWholeUsd,
              raw_beat_price_rate: s.rawBeatPriceRate,
              flat_adj_beat_price_rate: s.flatPriceAdjustedBeatPriceRate,
              raw_beat_points_rate: s.rawBeatPointsRate,
            })),
            temporal_holdout: {
              split_date: clf.behavioralScoringSpecification.temporalSplitDate,
              pr_auc: clf.temporalHoldoutEvaluation.prAuc,
              random_baseline_pr_auc:
                clf.temporalHoldoutEvaluation.randomBaselinePrAuc,
              pr_auc_lift_multiple:
                clf.temporalHoldoutEvaluation.prAucLiftMultiple,
              roc_auc: clf.temporalHoldoutEvaluation.rocAuc,
              operating_point_k53:
                clf.temporalHoldoutEvaluation.operatingPointK53,
              f1_optimal_point: clf.temporalHoldoutEvaluation.f1OptimalPoint,
            },
            permutation_null_percentiles: {
              totalWagers:
                nullCtrl.permutationNull.metrics.totalWagers
                  ?.empiricalPercentile,
              totalPlayerNetWholeUsd:
                nullCtrl.permutationNull.metrics.totalPlayerNetWholeUsd
                  ?.empiricalPercentile,
              aggBeatPriceRate:
                nullCtrl.permutationNull.metrics.aggBeatPriceRate
                  ?.empiricalPercentile,
              flatPriceAdjustedBeatPriceRate:
                nullCtrl.permutationNull.metrics.flatPriceAdjustedBeatPriceRate
                  ?.empiricalPercentile,
              aggBeatPointsRate:
                nullCtrl.permutationNull.metrics.aggBeatPointsRate
                  ?.empiricalPercentile,
              meanAccountPointsDelta:
                nullCtrl.permutationNull.metrics.meanAccountPointsDelta
                  ?.empiricalPercentile,
            },
            matched_control_and_did: {
              raw_vs_control: nullCtrl.matchedControlCohort.rawVsControlSummary,
              temporal_did:
                nullCtrl.matchedControlCohort.temporalDifferenceInDifferences,
              ayman_laythechalk_decomposition:
                nullCtrl.matchedControlCohort.aymanLaythechalkDecomposition,
            },
            fdr_and_shrinkage: {
              total_grid_cells: fdr.totalGridCellsTested,
              raw_p_below_05: fdr.rawPBelow05Count,
              surviving_bh_fdr_q05: fdr.survivingFdrQ05Count,
              surviving_cells: fdr.survivingCells.map((c) => ({
                cellKey: c.cellKey,
                wagers: c.wagerCount,
                beatPointsRate: c.beatPointsRate,
                flatAdjBeatPriceRate: c.flatAdjBeatPriceRate,
                combinedClvBeatRate: c.combinedClvBeatRate,
                rawPValue: c.rawPValue,
                bhAdjustedQValue: c.bhAdjustedQValue,
                playerNetWholeUsd: c.playerNetWholeUsd,
              })),
              empirical_bayes_prior: fdr.empiricalBayesPrior,
            },
            reconciliation: {
              all_levels_reconciled_to_penny: rec.allLevelsReconciledToPenny,
              max_discrepancy_cents: rec.maxDiscrepancyCents,
              prior_discrepancy_root_cause: rec.priorDiscrepancyRootCause,
              level_checks: rec.levelChecks,
            },
          },
          acceptance_scorecard: sc,
        },
        null,
        2,
      ),
    );
  }

  if (!report.acceptance_scorecard.allCriteriaPassed) {
    throw new Error(
      `Suspected-bot validation acceptance gate failed: ${JSON.stringify(report.acceptance_scorecard)}`,
    );
  }

  return report;
}

if (import.meta.main) {
  await runAnalyzeSuspectedBotsCli();
}
