import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMatchEvaluationStore,
  evaluateCandidateOverlay,
  evaluationStateFromResult,
  F402_DIRECTORY_EVIDENCE_NCAAF,
  hashCanonicalPayload,
  hashEvaluationResult,
  metadataFieldState,
  normalizePaddedField,
  replayPolicyDelta,
  serializeMatchEvaluationResult,
  ValidTimeReplayError,
  MATCH_EVALUATIONS_AUTO_ACCEPT_WHERE,
  MATCH_EVALUATIONS_REVIEW_QUEUE_WHERE,
  type PendingWagerInput,
  type TickerOverlayInput,
} from "../lib/candidate_match_evaluation.ts";
import { auditRunAt, auditRunId } from "../lib/audit_run_id.ts";
import { sha256HexFromDigest } from "../domain-branded-types.ts";
import { hashCanonicalJsonBytes } from "../lib/match_evaluation_canonical.ts";
import {
  DEFAULT_MATCH_POLICY,
  hashPolicy,
  type MatchPolicy,
} from "../lib/candidate_ticket_enrich.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

function loadPending(): PendingWagerInput {
  const j = JSON.parse(
    readFileSync(
      join(FIXTURE_DIR, "candidate-match-pending-football-college.json"),
      "utf8",
    ),
  ) as PendingWagerInput;
  return j;
}

function tickerFile1(pending: PendingWagerInput): TickerOverlayInput {
  return {
    matchKey: pending.matchKey,
    timeDifferenceMs: 8,
    payload: { lane: "GATEWAY", seq: 1 },
  };
}

function tickerFile2(pending: PendingWagerInput): TickerOverlayInput {
  return {
    matchKey: pending.matchKey,
    timeDifferenceMs: 12,
    payload: { lane: "GATEWAY", seq: 2 },
  };
}

describe("candidate_match_evaluation", () => {
  test("golden File 1 — evaluation_result_sha256 byte pin", () => {
    const pending = loadPending();
    const result = evaluateCandidateOverlay(tickerFile1(pending), pending);
    const bytes = serializeMatchEvaluationResult(result);
    const goldenBytes = readFileSync(
      join(FIXTURE_DIR, "candidate-match-evaluation-file1.golden.json"),
      "utf8",
    );
    const expectedSha = readFileSync(
      join(FIXTURE_DIR, "candidate-match-evaluation-file1.golden.sha256"),
      "utf8",
    ).trim();

    expect(bytes).toBe(goldenBytes);
    const pin = sha256HexFromDigest(expectedSha);
    expect(hashEvaluationResult(result)).toBe(pin);
    expect(hashCanonicalJsonBytes(goldenBytes)).toBe(pin);
  });

  test("golden File 2 — evaluation_result_sha256 byte pin", () => {
    const pending = loadPending();
    const result = evaluateCandidateOverlay(tickerFile2(pending), pending);
    const bytes = serializeMatchEvaluationResult(result);
    const goldenBytes = readFileSync(
      join(FIXTURE_DIR, "candidate-match-evaluation-file2.golden.json"),
      "utf8",
    );
    const expectedSha = readFileSync(
      join(FIXTURE_DIR, "candidate-match-evaluation-file2.golden.sha256"),
      "utf8",
    ).trim();

    expect(bytes).toBe(goldenBytes);
    expect(hashEvaluationResult(result)).toBe(sha256HexFromDigest(expectedSha));
  });

  test("File 1 — successful overlay within 10ms window", () => {
    const pending = loadPending();
    const result = evaluateCandidateOverlay(tickerFile1(pending), pending);
    expect(result.candidateRows).toBe(1);
    expect(result.unresolvedRows).toBe(0);
    expect(result.rejectedCandidates).toHaveLength(0);
    expect(result.candidate?.competitionFamily).toBe("NCAAF");
    expect(result.candidate?.directoryEvidenceId).toBe(
      F402_DIRECTORY_EVIDENCE_NCAAF,
    );
    expect(result.candidate?.nativeIdentityVerified).toBe(false);
    expect(result.candidate?.nativeEventId).toBe(null);
    expect(result.candidate?.shortDesc).toEqual({ state: "absent" });
    expect(result.candidate?.totalPointsOu).toEqual({ state: "null" });
    expect(result.candidate?.participant_1_code).toBe("ALA");
    expect(result.policySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.pendingSha256).toBe(hashCanonicalPayload(pending.payload));
  });

  test("File 2 — 12ms rejection, same pendingSha256, different ticker", () => {
    const pending = loadPending();
    const pendingSha = hashCanonicalPayload(pending.payload);

    const accept = evaluateCandidateOverlay(tickerFile1(pending), pending);
    const reject = evaluateCandidateOverlay(tickerFile2(pending), pending);

    expect(reject.pendingSha256).toBe(pendingSha);
    expect(reject.pendingSha256).toBe(accept.pendingSha256);
    expect(reject.tickerSha256).not.toBe(accept.tickerSha256);
    expect(reject.candidateRows).toBe(0);
    expect(reject.unresolvedRows).toBe(1);
    expect(reject.rejectedCandidates[0]?.rejectReason).toBe(
      "TIME_DIFF_EXCEEDED",
    );
    expect(reject.maxTimeDifferenceMs).toBe(DEFAULT_MATCH_POLICY.ms);
  });

  test("candidate-review — 12ms yields candidate + reviewFlag", () => {
    const pending = loadPending();
    const policy: MatchPolicy = { ms: 10, mode: "candidate-review" };
    const result = evaluateCandidateOverlay(
      tickerFile2(pending),
      pending,
      policy,
    );
    expect(result.candidateRows).toBe(1);
    expect(result.reviewFlag).toBe("TIME_DIFF_EXCEEDED");
    expect(result.rejectedCandidates).toHaveLength(0);
    expect(result.policySha256).not.toBe(hashPolicy(DEFAULT_MATCH_POLICY));
  });

  test("whitespace-normalized directory mapping (padded SportType)", () => {
    const pending = loadPending();
    expect(normalizePaddedField(pending.payload.SportType)).toBe("Football");
    expect(normalizePaddedField(pending.payload.SportSubType)).toBe("College");
  });

  test("metadata absent vs null distinction preserved in evaluation", () => {
    const pending = loadPending();
    expect(metadataFieldState(pending.payload, "ShortDesc")).toEqual({
      state: "absent",
    });
    expect(metadataFieldState(pending.payload, "TotalPointsOU")).toEqual({
      state: "null",
    });
  });

  test("match_evaluations append-only with run_id + canonical evaluation_json", () => {
    const pending = loadPending();
    const store = createMatchEvaluationStore();
    const ticker = tickerFile2(pending);
    const result = evaluateCandidateOverlay(ticker, pending);
    const runId = auditRunId("run-test-001");
    store.insertEvaluation({
      result,
      replayInput: { ticker, pending },
      runId,
      runAt: auditRunAt("2026-10-30T05:31:00.000Z"),
    });

    const rows = store.query<{
      run_id: string;
      state: string;
      reject_reason: string;
      evaluation_json_sha256: string;
      evaluation_json: string;
    }>(
      "SELECT run_id, state, reject_reason, evaluation_json, evaluation_json_sha256 FROM match_evaluations",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.run_id).toBe(runId);
    expect(rows[0]?.state).toBe("unresolved");
    expect(rows[0]?.reject_reason).toBe("TIME_DIFF_EXCEEDED");
    expect(rows[0]?.evaluation_json).toBe(
      serializeMatchEvaluationResult(result),
    );
    expect(rows[0]?.evaluation_json_sha256).toBe(hashEvaluationResult(result));
  });

  test("policy replay delta — 15ms accepts File 2 previously rejected at 10ms exact", () => {
    const pending = loadPending();
    const store = createMatchEvaluationStore();
    const baseline = DEFAULT_MATCH_POLICY;
    const baselineSha = hashPolicy(baseline);

    for (const [ticker, runAt] of [
      [tickerFile1(pending), "2026-10-01T00:00:00.000Z"],
      [tickerFile2(pending), "2026-10-02T00:00:00.000Z"],
    ] as const) {
      const result = evaluateCandidateOverlay(ticker, pending, baseline);
      store.insertEvaluation({
        result,
        replayInput: { ticker, pending },
        runId: auditRunId(`run-${runAt}`),
        runAt: auditRunAt(runAt),
      });
    }

    const v3: MatchPolicy = { ms: 15, mode: "exact" };
    const delta = replayPolicyDelta(store, baselineSha, v3, {
      since: "2026-09-01",
      until: "2026-11-01",
      sinceAxis: "run_at",
    });

    expect(delta.newlyAccepted).toBe(1);
    expect(delta.newlyRejected).toBe(0);
    expect(delta.unchanged).toBe(1);
    expect(evaluationStateFromResult(
      evaluateCandidateOverlay(tickerFile2(pending), pending, v3),
    )).toBe("candidate");
  });

  test("findSerializerDrift flags duplicate evaluation_json_sha256 for same triple", () => {
    const pending = loadPending();
    const store = createMatchEvaluationStore();
    const ticker = tickerFile1(pending);
    const baseline = DEFAULT_MATCH_POLICY;
    const result = evaluateCandidateOverlay(ticker, pending, baseline);
    store.insertEvaluation({
      result,
      replayInput: { ticker, pending, validTime: "2026-10-10T18:00:00.000Z" },
      runId: auditRunId("run-a"),
      runAt: auditRunAt("2026-10-01T00:00:00.000Z"),
    });
    const { candidate: _candidate, ...resultBase } = result;
    const mutated = {
      ...resultBase,
      candidateRows: 0,
      unresolvedRows: 1,
    };
    store.insertEvaluation({
      result: mutated,
      replayInput: { ticker, pending, validTime: "2026-10-10T18:00:00.000Z" },
      runId: auditRunId("run-b"),
      runAt: auditRunAt("2026-10-02T00:00:00.000Z"),
    });
    expect(store.findSerializerDrift().length).toBe(1);
  });

  test("valid_time axis refuses when validTime missing on stored rows", () => {
    const pending = loadPending();
    const store = createMatchEvaluationStore();
    const ticker = tickerFile1(pending);
    const baseline = DEFAULT_MATCH_POLICY;
    const baselineSha = hashPolicy(baseline);
    store.insertEvaluation({
      result: evaluateCandidateOverlay(ticker, pending, baseline),
      replayInput: { ticker, pending },
      runId: auditRunId("run-no-valid"),
      runAt: auditRunAt("2026-10-15T00:00:00.000Z"),
    });
    expect(() =>
      store.listLatestEvaluationsByPolicy(baselineSha, {
        sinceAxis: "valid_time",
        since: "2026-10-01",
      }),
    ).toThrow(ValidTimeReplayError);
  });

  test("valid_time window excludes market events outside range", () => {
    const pending = loadPending();
    const store = createMatchEvaluationStore();
    const baseline = DEFAULT_MATCH_POLICY;
    const baselineSha = hashPolicy(baseline);
    const tickerIn = tickerFile1(pending);
    const tickerOut = tickerFile2(pending);
    store.insertEvaluation({
      result: evaluateCandidateOverlay(tickerIn, pending, baseline),
      replayInput: {
        ticker: tickerIn,
        pending,
        validTime: "2026-10-05T12:00:00.000Z",
      },
      runId: auditRunId("in-range"),
      runAt: auditRunAt("2026-11-01T00:00:00.000Z"),
    });
    store.insertEvaluation({
      result: evaluateCandidateOverlay(tickerOut, pending, baseline),
      replayInput: {
        ticker: tickerOut,
        pending,
        validTime: "2026-09-01T12:00:00.000Z",
      },
      runId: auditRunId("out-range"),
      runAt: auditRunAt("2026-11-02T00:00:00.000Z"),
    });
    const byValid = store.listLatestEvaluationsByPolicy(baselineSha, {
      since: "2026-10-01",
      until: "2026-10-31",
      sinceAxis: "valid_time",
    });
    expect(byValid.length).toBe(1);
    const byRunAt = store.listLatestEvaluationsByPolicy(baselineSha, {
      since: "2026-10-01",
      until: "2026-10-31",
      sinceAxis: "run_at",
    });
    expect(byRunAt.length).toBe(0);
  });

  test("auto-accept WHERE contract is parenthesized for safe composition", () => {
    expect(MATCH_EVALUATIONS_AUTO_ACCEPT_WHERE).toBe(
      "(state = 'candidate' AND review_flag IS NULL)",
    );
    expect(MATCH_EVALUATIONS_REVIEW_QUEUE_WHERE).toBe(
      "(review_flag IS NOT NULL)",
    );
  });

  test("findValidTimeFork flags distinct valid_time for same ticker/pending", () => {
    const pending = loadPending();
    const store = createMatchEvaluationStore();
    const ticker = tickerFile1(pending);
    const result = evaluateCandidateOverlay(ticker, pending);
    store.insertEvaluation({
      result,
      replayInput: {
        ticker,
        pending,
        validTime: "2026-10-01T00:00:00.000Z",
      },
      runId: auditRunId("a"),
      runAt: auditRunAt("2026-10-01T00:00:00.000Z"),
    });
    store.insertEvaluation({
      result,
      replayInput: {
        ticker,
        pending,
        validTime: "2026-10-02T00:00:00.000Z",
      },
      runId: auditRunId("b"),
      runAt: auditRunAt("2026-10-02T00:00:00.000Z"),
    });
    expect(store.findValidTimeFork().length).toBe(1);
  });

  test("replay latency stats include tail gate fields", () => {
    const pending = loadPending();
    const store = createMatchEvaluationStore();
    const baseline = DEFAULT_MATCH_POLICY;
    const baselineSha = hashPolicy(baseline);
    store.insertEvaluation({
      result: evaluateCandidateOverlay(tickerFile2(pending), pending, baseline),
      replayInput: { ticker: tickerFile2(pending), pending },
      runId: auditRunId("tail"),
      runAt: auditRunAt("2026-10-01T00:00:00.000Z"),
    });
    const delta = replayPolicyDelta(store, baselineSha, baseline, {
      since: "2026-09-01",
      until: "2026-11-01",
    });
    expect(delta.latency.sampleCount).toBe(1);
    expect(delta.latency.batchWindow).toContain("run_at:");
    expect(delta.latency.absMaxMs).toBe(12);
  });
});
