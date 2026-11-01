/**
 * Overlay ↔ pending candidate ticket enrichment (GATEWAY / pending lane).
 */

import type { Database } from "bun:sqlite";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import type { Sha256Hex } from "../domain-branded-types.ts";
import { sha256HexOfBytes } from "../services/sportsdesk_ingestion_feed_provenance.ts";

export type MatchPolicyMode = "exact" | "candidate-review" | "reject";

export type MatchPolicy = {
  ms: number;
  mode: MatchPolicyMode;
};

export const DEFAULT_MATCH_POLICY: MatchPolicy = { ms: 10, mode: "exact" };

export type CandidateTicketRaw = Record<string, unknown> & {
  ShortName1?: string;
  ShortName2?: string;
};

export type CandidateOverlay = {
  matchKey: string;
  timeDiff: number;
};

export type CandidatePending = {
  matchKey: string;
  raw: CandidateTicketRaw;
};

export type CandidateRejectReason = "TIME_DIFF_EXCEEDED" | "MATCH_KEY_MISMATCH";

export type EnrichedCandidateRow = {
  matchKey: string;
  candidateStatus: "accepted" | "rejected";
  rejectReason?: CandidateRejectReason;
  /** Set when mode is candidate-review and |timeDiff| > ms — still accepted downstream. */
  reviewFlag?: CandidateRejectReason;
  timeDiff: number;
  policySha256: string;
  participant_1_code: string | null;
  participant_2_code: string | null;
  raw: CandidateTicketRaw;
};

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  });
}

export function hashPolicy(policy: MatchPolicy): Sha256Hex {
  const bytes = new TextEncoder().encode(stableStringify(policy));
  return sha256HexOfBytes(bytes);
}

function trimCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

export function enrich(
  overlay: CandidateOverlay,
  pending: CandidatePending,
  policy: MatchPolicy = DEFAULT_MATCH_POLICY,
): EnrichedCandidateRow {
  const policySha256 = hashPolicy(policy);
  const participant_1_code = trimCode(pending.raw.ShortName1);
  const participant_2_code = trimCode(pending.raw.ShortName2);

  const base: EnrichedCandidateRow = {
    matchKey: pending.matchKey,
    candidateStatus: "accepted",
    timeDiff: overlay.timeDiff,
    policySha256,
    participant_1_code,
    participant_2_code,
    raw: pending.raw,
  };

  if (overlay.matchKey !== pending.matchKey) {
    return {
      ...base,
      candidateStatus: "rejected",
      rejectReason: "MATCH_KEY_MISMATCH",
    };
  }

  const abs = Math.abs(overlay.timeDiff);
  const timeExceeded = abs > policy.ms;

  if (timeExceeded) {
    if (policy.mode === "candidate-review") {
      return {
        ...base,
        candidateStatus: "accepted",
        reviewFlag: "TIME_DIFF_EXCEEDED",
      };
    }
    if (policy.mode === "exact" || policy.mode === "reject") {
      return {
        ...base,
        candidateStatus: "rejected",
        rejectReason: "TIME_DIFF_EXCEEDED",
      };
    }
  }

  return base;
}

export function createCandidateTicketStore(
  db: Database = openSportsdeskSqlite(":memory:"),
): CandidateTicketStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_tickets (
      match_key TEXT NOT NULL,
      candidate_status TEXT NOT NULL,
      reject_reason TEXT,
      time_diff REAL NOT NULL,
      policy_sha256 TEXT NOT NULL,
      participant_1_code TEXT,
      participant_2_code TEXT,
      raw_json TEXT NOT NULL
    );
  `);
  return new CandidateTicketStore(db);
}

export class CandidateTicketStore {
  constructor(private readonly db: Database) {}

  write(row: EnrichedCandidateRow): void {
    this.db
      .query(
        `INSERT INTO candidate_tickets (
          match_key, candidate_status, reject_reason, time_diff,
          policy_sha256, participant_1_code, participant_2_code, raw_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        row.matchKey,
        row.candidateStatus,
        row.rejectReason ?? null,
        row.timeDiff,
        row.policySha256,
        row.participant_1_code,
        row.participant_2_code,
        JSON.stringify(row.raw),
      );
  }

  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): T[] {
    return this.db.query(sql).all() as T[];
  }
}
