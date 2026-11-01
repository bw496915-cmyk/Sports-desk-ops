import { describe, expect, test } from "bun:test";
import {
  type ProbeRecord,
  bestPerOperation,
  ensureProbeSchema,
  indexProbeRecords,
  latestPerOperation,
  openProbeIndex,
} from "../lib/probe_index.ts";

function record(overrides: Partial<ProbeRecord>): ProbeRecord {
  return {
    path: "a.json",
    operation: "Pending",
    status: 500,
    verdict: "error",
    bytes: 0,
    authMode: "env-login",
    capturedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

describe("probe index", () => {
  test("indexes, dedupes by path, and reports the latest per operation", async () => {
    const db = openProbeIndex();
    try {
      await ensureProbeSchema(db);
      await indexProbeRecords(db, [
        record({
          path: "run1/Pending.json",
          status: 500,
          verdict: "error",
          capturedAt: "2026-11-01T01:00:00Z",
        }),
        record({
          path: "run2/Pending.json",
          status: 400,
          verdict: "error",
          capturedAt: "2026-11-01T02:00:00Z",
        }),
        record({
          path: "run2/getGrading.json",
          operation: "getGrading",
          status: 200,
          verdict: "exists",
          bytes: 11,
          capturedAt: "2026-11-01T02:00:00Z",
        }),
      ]);

      const latest = await latestPerOperation(db);
      expect(latest.map((row) => row.operation)).toEqual([
        "Pending",
        "getGrading",
      ]);
      expect(latest.find((row) => row.operation === "Pending")?.status).toBe(
        400,
      );
      expect(
        latest.find((row) => row.operation === "getGrading")?.verdict,
      ).toBe("exists");

      // Re-indexing the same paths updates rather than duplicating.
      await indexProbeRecords(db, [
        record({
          path: "run2/Pending.json",
          status: 200,
          verdict: "exists",
          capturedAt: "2026-11-01T03:00:00Z",
        }),
      ]);
      const again = await latestPerOperation(db);
      expect(again.find((row) => row.operation === "Pending")?.status).toBe(
        200,
      );
      expect(again).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  test("best verdict prefers exists over denied over error", async () => {
    const db = openProbeIndex();
    try {
      await ensureProbeSchema(db);
      await indexProbeRecords(db, [
        record({
          path: "1.json",
          status: 401,
          verdict: "denied",
          capturedAt: "2026-11-01T00:00:00Z",
        }),
        record({
          path: "2.json",
          status: 500,
          verdict: "error",
          capturedAt: "2026-11-01T01:00:00Z",
        }),
        record({
          path: "3.json",
          operation: "getGrading",
          status: 200,
          verdict: "exists",
          capturedAt: "2026-11-01T01:00:00Z",
        }),
        record({
          path: "4.json",
          status: 404,
          verdict: "missing",
          capturedAt: "2026-11-01T02:00:00Z",
        }),
      ]);

      const best = await bestPerOperation(db);
      expect(best).toEqual([
        {
          operation: "Pending",
          attempts: 3,
          everExists: false,
          everDenied: true,
          lastStatus: 404,
        },
        {
          operation: "getGrading",
          attempts: 1,
          everExists: true,
          everDenied: false,
          lastStatus: 200,
        },
      ]);
    } finally {
      await db.close();
    }
  });
});
