import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  createWagerSettlementStore,
  extractValidTimeFromHistoryRow,
  fantasy402TicketId,
  normalizeHistoryWagerRow,
  normalizeSettlementBatch,
} from "../lib/fantasy402_settlement_ingest.ts";
import {
  activeWagerObservationSlicesForSettlementCount,
  assertPatternClaimAllowed,
  patternProvability,
} from "../lib/fantasy402_wager_universe_scope.ts";
import { auditRunAt, auditRunId } from "../lib/audit_run_id.ts";

describe("fantasy402_settlement_ingest", () => {
  test("future-game settled row uses SettlementDateTime as valid_time", () => {
    const row = {
      Login: "CUST001",
      WagerNumber: 42,
      WagerStatus: "S",
      AcceptedDateTime: "2026-10-21T01:10:00-05:00",
      GameDateTime: "2026-10-21T19:30:00-05:00",
      SettlementDateTime: "2026-10-21T22:00:00-05:00",
    };
    expect(extractValidTimeFromHistoryRow(row)).toBe(
      new Date("2026-10-21T22:00:00-05:00").toISOString(),
    );
    const obs = normalizeHistoryWagerRow(row)!;
    expect(obs.ticketId).toBe(fantasy402TicketId("CUST001", 42));
    expect(obs.wagerStatus).toBe("S");
  });

  test("fixture batch ingests append-only with run_id", () => {
    const fixture = join(
      import.meta.dir,
      "fixtures/fantasy402-history-poll.json",
    );
    const batch = normalizeSettlementBatch(
      JSON.parse(readFileSync(fixture, "utf8")) as {
        feed: "getHistory";
        polledAt: string;
        rows: Record<string, unknown>[];
      },
    );
    expect(batch.length).toBe(2);

    const store = createWagerSettlementStore();
    const n = store.ingestBatch(
      {
        feed: "getHistory",
        polledAt: "2026-10-21T08:00:00.000Z",
        rows: batch.map((b) => b.raw),
      },
      auditRunId("run-fixture-1"),
    );
    expect(n).toBe(2);
    expect(store.countByStatus("S")).toBe(1);
    expect(store.countByStatus("C")).toBe(1);
  });

  test("settlement observations unlock win/cancel pattern provability", () => {
    const store = createWagerSettlementStore();
    const slicesBefore = activeWagerObservationSlicesForSettlementCount(0);
    expect(patternProvability("win_loss_rate", slicesBefore)).toBe("blocked");

    store.ingestBatch(
      {
        feed: "getHistory",
        polledAt: "2026-10-21T08:00:00.000Z",
        rows: [
          {
            Login: "X",
            WagerNumber: 1,
            WagerStatus: "S",
            SettlementDateTime: "2026-10-21T22:00:00-05:00",
            Amount: 100,
          },
        ],
      },
      auditRunId("run-1"),
    );

    const slicesAfter = activeWagerObservationSlicesForSettlementCount(
      store.countObservations(),
    );
    expect(patternProvability("win_loss_rate", slicesAfter)).toBe("proven");
    expect(() =>
      assertPatternClaimAllowed("win_loss_rate", slicesAfter),
    ).not.toThrow();
  });

  test("payload drift invariant detects conflicting RAW captures", () => {
    const store = createWagerSettlementStore();
    const base = normalizeHistoryWagerRow({
      Login: "Z",
      WagerNumber: 9,
      WagerStatus: "S",
      SettlementDateTime: "2026-10-21T22:00:00-05:00",
      Amount: 1,
    })!;
    store.insertObservation({
      observation: base,
      runId: auditRunId("a"),
      runAt: auditRunAt("2026-10-21T08:00:00.000Z"),
    });
    store.insertObservation({
      observation: {
        ...base,
        raw: { ...base.raw, Amount: 2 },
        payloadSha256: "deadbeef",
      },
      runId: auditRunId("b"),
      runAt: auditRunAt("2026-10-21T09:00:00.000Z"),
    });
    expect(store.runStoreInvariants().ok).toBe(false);
  });

  test("CLI ingest subcommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "settlement-cli-"));
    const dbPath = join(dir, "lifecycle.sqlite");
    const fixture = join(
      import.meta.dir,
      "fixtures/fantasy402-history-poll.json",
    );
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "cli/sportsdesk_settlement_cli.ts",
        "ingest",
        "--db",
        dbPath,
        "--fixture",
        fixture,
        "--run-id",
        "test-run",
        "--json",
      ],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const db = new Database(dbPath);
    const store = createWagerSettlementStore(db);
    expect(store.countObservations()).toBe(2);
    db.close();
  });
});
