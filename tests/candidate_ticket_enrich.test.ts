import { describe, expect, test } from "bun:test";
import {
  createCandidateTicketStore,
  enrich,
  hashPolicy,
  type CandidateOverlay,
  type CandidatePending,
} from "../lib/candidate_ticket_enrich.ts";

const pending: CandidatePending = {
  matchKey: "wager-42",
  raw: {
    ShortName1: "  NYY  ",
    ShortName2: "BOS",
  },
};

const overlay: CandidateOverlay = {
  matchKey: "wager-42",
  timeDiff: 0,
};

describe("candidate_ticket_enrich", () => {
  test("exact match accepted", () => {
    const row = enrich(overlay, pending);
    expect(row.candidateStatus).toBe("accepted");
    expect(row.rejectReason).toBeUndefined();
  });

  test("10ms boundary: 10.0 accepted, 10.001 rejected", () => {
    expect(
      enrich({ ...overlay, timeDiff: 10.0 }, pending).candidateStatus,
    ).toBe("accepted");
    const over = enrich({ ...overlay, timeDiff: 10.001 }, pending);
    expect(over.candidateStatus).toBe("rejected");
    expect(over.rejectReason).toBe("TIME_DIFF_EXCEEDED");
  });

  test("negative diff (clock skew): -11ms rejected", () => {
    const row = enrich({ ...overlay, timeDiff: -11 }, pending);
    expect(row.candidateStatus).toBe("rejected");
    expect(row.rejectReason).toBe("TIME_DIFF_EXCEEDED");
  });

  test("policySha256 stable across key reorder", () => {
    const a = hashPolicy({ ms: 10, mode: "exact" });
    const b = hashPolicy({ mode: "exact", ms: 10 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejected row still persists", async () => {
    const store = createCandidateTicketStore();
    const rejectedRow = enrich({ ...overlay, timeDiff: 10.001 }, pending);
    expect(rejectedRow.candidateStatus).toBe("rejected");
    store.write(rejectedRow);
    const rows = store.query<{ candidate_status: string }>(
      "SELECT * FROM candidate_tickets WHERE candidate_status='rejected'",
    );
    expect(rows.length).toBe(1);
  });

  test("flattened participant fidelity", () => {
    const row = enrich(overlay, pending);
    expect(row.participant_1_code).toBe(pending.raw.ShortName1!.trim());
    expect(row.participant_2_code).toBe("BOS");
  });

  test("candidate-review accepts over-threshold time with reviewFlag", () => {
    const row = enrich({ ...overlay, timeDiff: 12 }, pending, {
      ms: 10,
      mode: "candidate-review",
    });
    expect(row.candidateStatus).toBe("accepted");
    expect(row.reviewFlag).toBe("TIME_DIFF_EXCEEDED");
    expect(row.rejectReason).toBeUndefined();
  });
});
