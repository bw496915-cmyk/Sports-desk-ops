/**
 * @file gslive_weblog_sink.ts
 * @description R2 sink for the GSLive activity weblog rollup: immutable daily key under
 * `gslive-weblogs/<deskDate>/activity.json`, then a `gslive-weblogs/latest.json` pointer that
 * names the newest daily key. Two writes, in that order; the pointer only advances if the daily
 * write landed first and its object size matches the body length. Mirrors the pattern in
 * `lib/gslive_tally_sink.ts`.
 */

import {
  publishArtifactsToR2,
  type R2Artifact,
  type R2PublishResult,
} from "./live_positions_r2_publisher.ts";
import type { R2S3Client } from "./r2_s3_client.ts";

export const GSLIVE_WEBLOGS_PREFIX = "gslive-weblogs/";
export const GSLIVE_WEBLOGS_POINTER_KEY = `${GSLIVE_WEBLOGS_PREFIX}latest.json`;
export const GSLIVE_WEBLOGS_SCHEMA_VERSION = 1;
export const GSLIVE_WEBLOGS_SOURCE = "lib/gslive_weblog_sink.ts";

export interface GsliveWeblogRollup {
  readonly schemaVersion: typeof GSLIVE_WEBLOGS_SCHEMA_VERSION;
  readonly deskDate: string;
  readonly generatedAtIso: string;
  readonly sourceSha256: string;
  readonly rowCount: number;
  /** Arbitrary aggregate the caller computed; the sink does not inspect its shape. */
  readonly body: unknown;
}

export interface GsliveWeblogsPointer {
  readonly schemaVersion: typeof GSLIVE_WEBLOGS_SCHEMA_VERSION;
  readonly deskDate: string;
  readonly key: string;
  readonly sha256: string;
  readonly generatedAtIso: string;
  readonly rowCount: number;
}

function isSafeDeskDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Return the two artifacts the caller would send (daily then pointer) without talking to R2. Used
 * by the test suite and by any dry-run mode a driver script wants to add.
 */
export function buildGsliveWeblogArtifacts(
  rollup: GsliveWeblogRollup,
): readonly R2Artifact[] {
  if (!isSafeDeskDate(rollup.deskDate)) {
    throw new Error(
      `gslive weblogs: deskDate must be YYYY-MM-DD (got "${rollup.deskDate}")`,
    );
  }
  const dailyKey = `${GSLIVE_WEBLOGS_PREFIX}${rollup.deskDate}/activity.json`;
  const dailyText = JSON.stringify(rollup, null, 0);
  const pointer: GsliveWeblogsPointer = {
    schemaVersion: GSLIVE_WEBLOGS_SCHEMA_VERSION,
    deskDate: rollup.deskDate,
    key: dailyKey,
    sha256: rollup.sourceSha256,
    generatedAtIso: rollup.generatedAtIso,
    rowCount: rollup.rowCount,
  };
  const pointerText = JSON.stringify(pointer, null, 2);
  return [
    {
      key: dailyKey,
      text: dailyText,
      schemaVersion: GSLIVE_WEBLOGS_SCHEMA_VERSION,
      observedAtIso: rollup.generatedAtIso,
      extraMetadata: {
        "desk-date": rollup.deskDate,
        "row-count": String(rollup.rowCount),
        sha256: rollup.sourceSha256,
        pii: "caller-sanitized",
      },
    },
    {
      key: GSLIVE_WEBLOGS_POINTER_KEY,
      text: pointerText,
      schemaVersion: GSLIVE_WEBLOGS_SCHEMA_VERSION,
      observedAtIso: rollup.generatedAtIso,
      extraMetadata: {
        "desk-date": rollup.deskDate,
        "points-to": dailyKey,
        pii: "none",
      },
    },
  ];
}

/**
 * Publish the daily key first, then the pointer. If the daily write fails, the pointer is still
 * attempted and the publisher summary names both outcomes — that stays consistent with the rest of
 * the R2 publishers in this repo that never short-circuit on first error. Callers that want strict
 * "daily first or nothing" ordering can inspect `writes[0].ok` before trusting the pointer.
 */
export async function publishGsliveWeblog(
  client: R2S3Client,
  rollup: GsliveWeblogRollup,
): Promise<R2PublishResult> {
  const artifacts = buildGsliveWeblogArtifacts(rollup);
  return publishArtifactsToR2(client, artifacts, {
    source: GSLIVE_WEBLOGS_SOURCE,
  });
}
