/**
 * Append-only combo observations per venue (internal vs polymarket).
 */

import type { Database } from "bun:sqlite";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import { type AuditRunId, type IsoDateTimeUtc } from "./audit_run_id.ts";
import type { ComboLegSemantic } from "./canonical_combo_index.ts";
import { serializeComboLegs } from "./canonical_combo_index.ts";
import { canonicalJsonString } from "./match_evaluation_canonical.ts";
import { sha256HexOfBytes } from "../sportsdesk_ingestion_feed_provenance.ts";

export type ComboVenue = "internal" | "polymarket";

export type ComboVenueObservationInsert = {
  canonicalComboId: string;
  venue: ComboVenue;
  venueRef: string;
  validTime: string;
  legs: ComboLegSemantic[];
  runId: AuditRunId;
  runAt: IsoDateTimeUtc;
  wireJson?: Record<string, unknown>;
};

export function createComboVenueStore(
  db: Database = openSportsdeskSqlite(":memory:"),
): ComboVenueStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS combo_legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      canonical_combo_id TEXT NOT NULL,
      venue TEXT NOT NULL,
      venue_ref TEXT NOT NULL,
      valid_time TEXT NOT NULL,
      leg_index INTEGER NOT NULL,
      leg_json TEXT NOT NULL,
      wire_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_combo_legs_combo_venue
      ON combo_legs(canonical_combo_id, venue, valid_time);
    CREATE INDEX IF NOT EXISTS idx_combo_legs_valid_time ON combo_legs(valid_time);
  `);
  return new ComboVenueStore(db);
}

export class ComboVenueStore {
  constructor(private readonly db: Database) {}

  insertObservation(row: ComboVenueObservationInsert): void {
    const wireJson = row.wireJson
      ? canonicalJsonString(row.wireJson)
      : null;
    row.legs.forEach((leg, legIndex) => {
      this.db
        .query(
          `INSERT INTO combo_legs (
            run_id, run_at, canonical_combo_id, venue, venue_ref,
            valid_time, leg_index, leg_json, wire_json
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          row.runId,
          row.runAt,
          row.canonicalComboId,
          row.venue,
          row.venueRef,
          row.validTime,
          legIndex,
          serializeComboLegs([leg]),
          wireJson,
        );
    });
  }

  /** MIN(valid_time) per (canonical_combo_id, venue) — first-seen for lead-lag. */
  listFirstSeenByVenue(): ComboFirstSeenRow[] {
    return this.db
      .query(
        `SELECT canonical_combo_id, venue,
                MIN(valid_time) AS first_valid_time,
                MIN(venue_ref) AS venue_ref
         FROM combo_legs
         GROUP BY canonical_combo_id, venue`,
      )
      .all() as ComboFirstSeenRow[];
  }

  countLegRows(): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM combo_legs`).get() as {
      n: number;
    };
    return row.n;
  }
}

export type ComboFirstSeenRow = {
  canonical_combo_id: string;
  venue: ComboVenue;
  first_valid_time: string;
  venue_ref: string;
};

export function hashComboWire(raw: Record<string, unknown>): string {
  return sha256HexOfBytes(
    new TextEncoder().encode(canonicalJsonString(raw)),
  );
}
