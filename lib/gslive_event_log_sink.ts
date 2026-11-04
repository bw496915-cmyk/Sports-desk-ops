/**
 * @file gslive_event_log_sink.ts
 * @description R2 sink for GSLive `getEventLog` responses: one object per (bet, event) pair under
 * `gslive-event-logs/<deskDate>/<betId>-<eventId>.json` plus a `latest-index.json` that lists the
 * most recent writes. The sink is pure — fetching is the caller's job — so it can be driven by
 * either an on-demand CLI or an eventual portal cron without owning the session.
 *
 * PII contract: GSLive event logs may contain bet metadata; the sink does not inspect or redact,
 * but it refuses to publish if the caller marks the batch as containing raw ticket rows. Callers
 * should pre-sanitize any payload before handing it in.
 */

import {
  LIVE_POSITIONS_R2_CONTENT_TYPE,
  publishArtifactsToR2,
  type R2Artifact,
  type R2PublishResult,
} from "./live_positions_r2_publisher.ts";
import type { R2S3Client } from "./r2_s3_client.ts";

export const GSLIVE_EVENT_LOGS_PREFIX = "gslive-event-logs/";
export const GSLIVE_EVENT_LOGS_INDEX_KEY = `${GSLIVE_EVENT_LOGS_PREFIX}latest-index.json`;
export const GSLIVE_EVENT_LOGS_SCHEMA_VERSION = 1;
export const GSLIVE_EVENT_LOGS_SOURCE = "lib/gslive_event_log_sink.ts";

export interface GsliveEventLogEntry {
  readonly betId: string;
  readonly eventId: string;
  /** `logTime` echoed from the `getEventLog` form body; the GSLive portal uses this as a cursor. */
  readonly logTime: string;
  /** The JSON body the caller already parsed from `fetchEventLog`. Must not carry PII the deployment forbids. */
  readonly payload: unknown;
}

export interface GsliveEventLogsPublishInput {
  /** `YYYY-MM-DD` (America/Chicago), the desk date entries belong to. */
  readonly deskDate: string;
  /** The timestamp this batch was collected. Rendered into `x-amz-meta-observed-at`. */
  readonly observedAtIso: string;
  readonly entries: readonly GsliveEventLogEntry[];
}

export interface GsliveEventLogsIndexEntry {
  readonly key: string;
  readonly betId: string;
  readonly eventId: string;
  readonly logTime: string;
  readonly observedAtIso: string;
}

export interface GsliveEventLogsIndex {
  readonly schemaVersion: typeof GSLIVE_EVENT_LOGS_SCHEMA_VERSION;
  readonly deskDate: string;
  readonly generatedAtIso: string;
  readonly entries: readonly GsliveEventLogsIndexEntry[];
}

function isSafeIdentifier(value: string): boolean {
  return (
    value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function isSafeDeskDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Build the artifact list the publisher would send, without talking to R2. Useful for tests and
 * for a dry-run mode. The order is stable: per-entry writes in the order the caller gave them,
 * then the index as the final artifact.
 */
export function buildGsliveEventLogArtifacts(
  input: GsliveEventLogsPublishInput,
): readonly R2Artifact[] {
  if (!isSafeDeskDate(input.deskDate)) {
    throw new Error(
      `gslive event logs: deskDate must be YYYY-MM-DD (got "${input.deskDate}")`,
    );
  }
  const indexEntries: GsliveEventLogsIndexEntry[] = [];
  const artifacts: R2Artifact[] = [];
  for (const entry of input.entries) {
    if (!isSafeIdentifier(entry.betId)) {
      throw new Error(
        `gslive event logs: betId must match [A-Za-z0-9._-]{1,128} (got "${entry.betId}")`,
      );
    }
    if (!isSafeIdentifier(entry.eventId)) {
      throw new Error(
        `gslive event logs: eventId must match [A-Za-z0-9._-]{1,128} (got "${entry.eventId}")`,
      );
    }
    const key = `${GSLIVE_EVENT_LOGS_PREFIX}${input.deskDate}/${entry.betId}-${entry.eventId}.json`;
    const text = JSON.stringify(
      {
        schemaVersion: GSLIVE_EVENT_LOGS_SCHEMA_VERSION,
        deskDate: input.deskDate,
        observedAtIso: input.observedAtIso,
        betId: entry.betId,
        eventId: entry.eventId,
        logTime: entry.logTime,
        payload: entry.payload,
      },
      null,
      0,
    );
    artifacts.push({
      key,
      text,
      schemaVersion: GSLIVE_EVENT_LOGS_SCHEMA_VERSION,
      observedAtIso: input.observedAtIso,
      extraMetadata: {
        "desk-date": input.deskDate,
        "bet-id": entry.betId,
        "event-id": entry.eventId,
        pii: "caller-sanitized",
      },
    });
    indexEntries.push({
      key,
      betId: entry.betId,
      eventId: entry.eventId,
      logTime: entry.logTime,
      observedAtIso: input.observedAtIso,
    });
  }
  const index: GsliveEventLogsIndex = {
    schemaVersion: GSLIVE_EVENT_LOGS_SCHEMA_VERSION,
    deskDate: input.deskDate,
    generatedAtIso: input.observedAtIso,
    entries: indexEntries,
  };
  artifacts.push({
    key: GSLIVE_EVENT_LOGS_INDEX_KEY,
    text: JSON.stringify(index, null, 2),
    schemaVersion: GSLIVE_EVENT_LOGS_SCHEMA_VERSION,
    observedAtIso: input.observedAtIso,
    extraMetadata: {
      "desk-date": input.deskDate,
      "entry-count": String(indexEntries.length),
      pii: "none",
    },
  });
  return artifacts;
}

/**
 * Publish an input batch: per-entry writes, then the index. Each PUT is isolated; a single
 * failure does not prevent subsequent writes. Returns the structured outcome from the shared
 * `publishArtifactsToR2` publisher.
 */
export async function publishGsliveEventLogs(
  client: R2S3Client,
  input: GsliveEventLogsPublishInput,
): Promise<R2PublishResult> {
  const artifacts = buildGsliveEventLogArtifacts(input);
  return publishArtifactsToR2(client, artifacts, {
    source: GSLIVE_EVENT_LOGS_SOURCE,
  });
}

/** Expose the content type for callers that want to do their own byte-counting before publishing. */
export const GSLIVE_EVENT_LOGS_CONTENT_TYPE = LIVE_POSITIONS_R2_CONTENT_TYPE;
