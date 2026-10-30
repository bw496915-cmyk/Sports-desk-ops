/**
 * Append-only Manager/getHistory + getGrading observations (wager lifecycle slice).
 */

import type { Database } from "bun:sqlite";
import { openSportsdeskSqlite, sqlInt } from "./sportsdesk_sqlite.ts";
import {
  auditRunAt,
  type AuditRunId,
  type IsoDateTimeUtc,
} from "./audit_run_id.ts";
import { canonicalJsonString } from "./match_evaluation_canonical.ts";
import { sha256HexOfBytes } from "../sportsdesk_ingestion_feed_provenance.ts";
/** Same semantics as candidate verify/replay store invariant exit (5). */
export const SETTLEMENT_EXIT_STORE_INVARIANT = 5;

export type SettlementFeed = "getHistory" | "getGrading";

export type WagerStatusWire = "P" | "S" | "C" | string;

export type RawHistoryWagerRow = Record<string, unknown> & {
  Login?: string;
  CustomerID?: string;
  WagerNumber?: number;
  WagerStatus?: string;
  AcceptedDateTime?: string;
  GameDateTime?: string;
  SettlementDateTime?: string;
  Amount?: number;
  Risk?: number;
  ToWin?: number;
  PlayNumber?: number;
  ItemNumber?: number;
};

export type RawGradingLegWire = Record<string, unknown> & {
  CustomerID?: string;
  WagerNumber?: number;
  LegNumber?: number;
  Amount?: number;
  SettlementDateTime?: string;
  Result?: string;
};

export type NormalizedSettlementObservation = {
  ticketId: string;
  login: string;
  wagerNumber: number;
  wagerStatus: string;
  validTime: string;
  sourceFeed: SettlementFeed;
  legNumber: number | null;
  result: string | null;
  amountCents: number | null;
  raw: Record<string, unknown>;
  payloadSha256: string;
};

export function fantasy402TicketId(login: string, wagerNumber: number): string {
  return `${login.trim().toUpperCase()}|${wagerNumber}`;
}

function hashRawPayload(raw: Record<string, unknown>): string {
  return sha256HexOfBytes(new TextEncoder().encode(canonicalJsonString(raw)));
}

function parseIsoTime(label: string, value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function extractValidTimeFromHistoryRow(
  row: RawHistoryWagerRow,
): string {
  return (
    parseIsoTime("SettlementDateTime", row.SettlementDateTime) ??
    parseIsoTime("GameDateTime", row.GameDateTime) ??
    parseIsoTime("AcceptedDateTime", row.AcceptedDateTime) ??
    parseIsoTime("InsertDateTime", row.InsertDateTime as string | undefined) ??
    new Date(0).toISOString()
  );
}

export function normalizeWagerStatus(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const t = raw.trim().toUpperCase();
  return t.length > 0 ? t.charAt(0) : "unknown";
}

export function normalizeHistoryWagerRow(
  row: RawHistoryWagerRow,
  sourceFeed: SettlementFeed = "getHistory",
): NormalizedSettlementObservation | null {
  const loginRaw = row.Login ?? row.CustomerID;
  const wagerNumber = row.WagerNumber;
  if (typeof loginRaw !== "string" || typeof wagerNumber !== "number") {
    return null;
  }
  const login = loginRaw.trim();
  const wagerStatus = normalizeWagerStatus(row.WagerStatus);
  const validTime = extractValidTimeFromHistoryRow(row);
  const raw = { ...row };
  return {
    ticketId: fantasy402TicketId(login, wagerNumber),
    login,
    wagerNumber,
    wagerStatus,
    validTime,
    sourceFeed,
    legNumber:
      typeof row.ItemNumber === "number"
        ? row.ItemNumber
        : typeof row.PlayNumber === "number"
          ? row.PlayNumber
          : null,
    result: null,
    amountCents: typeof row.Amount === "number" ? Math.round(row.Amount) : null,
    raw,
    payloadSha256: hashRawPayload(raw),
  };
}

export function normalizeGradingLegRow(
  row: RawGradingLegWire,
): NormalizedSettlementObservation | null {
  const customerId = row.CustomerID;
  const wagerNumber = row.WagerNumber;
  if (typeof customerId !== "string" || typeof wagerNumber !== "number") {
    return null;
  }
  const login = customerId.trim();
  const validTime =
    parseIsoTime("SettlementDateTime", row.SettlementDateTime) ??
    new Date(0).toISOString();
  const raw = { ...row };
  return {
    ticketId: fantasy402TicketId(login, wagerNumber),
    login,
    wagerNumber,
    wagerStatus: "S",
    validTime,
    sourceFeed: "getGrading",
    legNumber: typeof row.LegNumber === "number" ? row.LegNumber : null,
    result:
      typeof row.Result === "string" ? row.Result.trim().toUpperCase() : null,
    amountCents: typeof row.Amount === "number" ? Math.round(row.Amount) : null,
    raw,
    payloadSha256: hashRawPayload(raw),
  };
}

export type SettlementPollBatch = {
  feed: SettlementFeed;
  polledAt: string;
  rows: Record<string, unknown>[];
};

export function normalizeSettlementBatch(
  batch: SettlementPollBatch,
): NormalizedSettlementObservation[] {
  const out: NormalizedSettlementObservation[] = [];
  for (const row of batch.rows) {
    const obs =
      batch.feed === "getGrading"
        ? normalizeGradingLegRow(row as RawGradingLegWire)
        : normalizeHistoryWagerRow(row as RawHistoryWagerRow, batch.feed);
    if (obs) out.push(obs);
  }
  return out;
}

export type SettlementInsert = {
  observation: NormalizedSettlementObservation;
  runId: AuditRunId;
  runAt: IsoDateTimeUtc;
};

/**
 * Append-only lifecycle observations. payload_json is RAW wire row (not normalized).
 */
export function createWagerSettlementStore(
  db: Database = openSportsdeskSqlite(":memory:"),
): WagerSettlementStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wager_settlement_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      valid_time TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      wager_status TEXT NOT NULL,
      source_feed TEXT NOT NULL,
      leg_number INTEGER,
      result TEXT,
      amount_cents INTEGER,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wso_ticket ON wager_settlement_observations(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_wso_valid_time ON wager_settlement_observations(valid_time);
    CREATE INDEX IF NOT EXISTS idx_wso_run_at ON wager_settlement_observations(run_at);
  `);
  return new WagerSettlementStore(db);
}

export class WagerSettlementStore {
  constructor(private readonly db: Database) {}

  insertObservation(row: SettlementInsert): void {
    const { observation, runId, runAt } = row;
    const payloadJson = canonicalJsonString(observation.raw);
    this.db
      .query(
        `INSERT INTO wager_settlement_observations (
          run_id, run_at, valid_time, ticket_id, wager_status, source_feed,
          leg_number, result, amount_cents, payload_json, payload_sha256
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .run(
        runId,
        runAt,
        observation.validTime,
        observation.ticketId,
        observation.wagerStatus,
        observation.sourceFeed,
        observation.legNumber,
        observation.result,
        observation.amountCents,
        payloadJson,
        observation.payloadSha256,
      );
  }

  ingestBatch(batch: SettlementPollBatch, runId: AuditRunId): number {
    const runAt = auditRunAt(batch.polledAt);
    let n = 0;
    for (const observation of normalizeSettlementBatch(batch)) {
      this.insertObservation({ observation, runId, runAt });
      n += 1;
    }
    return n;
  }

  countObservations(): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM wager_settlement_observations`)
      .get() as { n: number | bigint };
    return sqlInt(row.n);
  }

  countByStatus(wagerStatus: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM wager_settlement_observations WHERE wager_status = ?1`,
      )
      .get(wagerStatus) as { n: number | bigint };
    return sqlInt(row.n);
  }

  findPayloadDrift(): SettlementPayloadDriftRow[] {
    return this.db
      .query(
        `SELECT ticket_id, valid_time, wager_status, source_feed,
                COUNT(DISTINCT payload_sha256) AS distinct_payloads
         FROM wager_settlement_observations
         GROUP BY ticket_id, valid_time, wager_status, source_feed
         HAVING COUNT(DISTINCT payload_sha256) > 1`,
      )
      .all() as SettlementPayloadDriftRow[];
  }

  findValidTimeFork(): SettlementValidTimeForkRow[] {
    return this.db
      .query(
        `SELECT ticket_id, wager_status,
                COUNT(DISTINCT valid_time) AS distinct_valid_times
         FROM wager_settlement_observations
         WHERE wager_status IN ('S', 'C')
         GROUP BY ticket_id, wager_status
         HAVING COUNT(DISTINCT valid_time) > 1`,
      )
      .all() as SettlementValidTimeForkRow[];
  }

  runStoreInvariants(): SettlementInvariantReport {
    const payloadDrift = this.findPayloadDrift();
    const validTimeFork = this.findValidTimeFork();
    return {
      ok: payloadDrift.length === 0 && validTimeFork.length === 0,
      payloadDrift,
      validTimeFork,
    };
  }

  /** Win/loss denominator: settled legs/tickets with WIN/LOSS result or Amount != 0. */
  summarizeOutcomeRates(): {
    settled: number;
    canceled: number;
    wins: number;
    losses: number;
  } {
    const settled = this.countByStatus("S");
    const canceled = this.countByStatus("C");
    const wins = this.db
      .query(
        `SELECT COUNT(*) AS n FROM wager_settlement_observations
           WHERE result = 'WIN' OR (wager_status = 'S' AND amount_cents > 0)`,
      )
      .get() as { n: number | bigint };
    const losses = this.db
      .query(
        `SELECT COUNT(*) AS n FROM wager_settlement_observations
           WHERE result = 'LOSS' OR (wager_status = 'S' AND amount_cents < 0)`,
      )
      .get() as { n: number | bigint };
    return {
      settled,
      canceled,
      wins: sqlInt(wins.n),
      losses: sqlInt(losses.n),
    };
  }
}

export type SettlementPayloadDriftRow = {
  ticket_id: string;
  valid_time: string;
  wager_status: string;
  source_feed: string;
  distinct_payloads: number;
};

export type SettlementValidTimeForkRow = {
  ticket_id: string;
  wager_status: string;
  distinct_valid_times: number;
};

export type SettlementInvariantReport = {
  ok: boolean;
  payloadDrift: SettlementPayloadDriftRow[];
  validTimeFork: SettlementValidTimeForkRow[];
};

export function resolveHistoryPollUrl(baseUrl?: string): string {
  const base =
    baseUrl?.replace(/\/$/, "") ??
    process.env.SPORTSDESK_PORTAL_HTTP_BASE?.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "SPORTSDESK_PORTAL_HTTP_BASE is required for live getHistory poll",
    );
  }
  return `${base}/cloud/api/Manager/getHistory`;
}

export async function pollManagerGetHistory(options?: {
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<{ polledAt: string; rows: Record<string, unknown>[] }> {
  const url = resolveHistoryPollUrl(options?.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    proxy: false,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    throw new Error(`getHistory poll failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  const polledAt = new Date().toISOString();
  if (Array.isArray(body)) {
    return { polledAt, rows: body as Record<string, unknown>[] };
  }
  if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as { data?: unknown }).data)
  ) {
    return {
      polledAt,
      rows: (body as { data: Record<string, unknown>[] }).data,
    };
  }
  throw new Error("getHistory response is not an array or { data: [] }");
}
