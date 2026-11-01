/**
 * @file f402_bet_ticker_config.ts
 * @description The bet ticker's configuration: the `INFO` object `getBetTickerConfig` returns, and
 * the form body `updateBetTickerConfig` sends.
 *
 * Three properties of this pair are easy to get wrong and silent when wrong — all three are pinned by
 * `tests/f402_bet_ticker_config.test.ts` against an observed pair from 2026-11-01
 * (`tests/fixtures/f402-bet-ticker-config-2026-11-01.json`):
 *
 *  1. **Two namings for one set of buckets.** The read keys are ranges (`play1-499`), the write
 *     fields are upper bounds (`play499`). Six buckets, contiguous:
 *     1-499, 500-999, 1000-1999, 2000-4999, 5000-9999, 10000-100000.
 *  2. **Flag values are padded asymmetrically.** Enabled is `"on "` with a trailing space, disabled
 *     is `"off"` without one — so `=== "on"` is false for everything enabled. See
 *     `f402_flag_values.ts`, which now holds the trim rule.
 *  3. **`AgentID` changes width.** Unpadded in the request, padded to 50 characters in the response.
 *
 * The write builder exists so a future read-side integration cannot hand-assemble a body, but this
 * module does not call it: the repo does not mutate production ticker settings.
 */

import { isFlagOn, normalizeOnOffFlag } from "./f402_flag_values.ts";

import { TICKER_AGENT_ID_WIDTH } from "./f402_field_widths.ts";

/** `AgentID` in the response, padded to this width (measured: 8-char login + 42 spaces). */
export { TICKER_AGENT_ID_WIDTH };

export interface TickeredBucket {
  /** Inclusive lower bound of the bucket, as implied by the range key. */
  readonly low: number;
  /** Inclusive upper bound; also the suffix of the write field names. */
  readonly high: number;
  /** Read key for the play flag, e.g. `play1-499`. */
  readonly playKey: string;
  /** Read key for the colour, e.g. `color1-499`. */
  readonly colorKey: string;
  /** Write field for the play flag, e.g. `play499`. */
  readonly playField: string;
  /** Write field for the colour, e.g. `color499`. */
  readonly colorField: string;
  readonly enabled: boolean;
  /** `#rrggbb`, or null when the portal sent something that is not a hex colour. */
  readonly color: string | null;
}

export interface TickerConfig {
  /** `AgentID` with its padding removed. */
  readonly agentId: string;
  readonly agentIdPadded: boolean;
  readonly buckets: readonly TickeredBucket[];
  readonly showHorses: boolean;
  readonly showIfbets: boolean;
  readonly showParlays: boolean;
  readonly showStraights: boolean;
  readonly showTeasers: boolean;
  /** Keys present in `INFO` that this parser does not model, so a changed contract is visible. */
  readonly unknownKeys: readonly string[];
}

const BUCKET_RANGES: readonly (readonly [number, number])[] = [
  [1, 499],
  [500, 999],
  [1000, 1999],
  [2000, 4999],
  [5000, 9999],
  [10000, 100000],
];

const SHOW_FLAGS = {
  showHorses: "showHorses",
  showIfbets: "showIfbets",
  showParlays: "showParlays",
  showStraights: "showStraights",
  showTeasers: "showTeasers",
} as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Parses `{ INFO: { … } }`, or a bare `INFO` object.
 *
 * Returns null when the shape is the misconfigured `INFO: false` variant, which no capture has ever
 * shown: it must not be read as "no buckets configured".
 */
export function parseTickerConfig(payload: unknown): TickerConfig | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const info =
    record.INFO !== undefined && typeof record.INFO === "object"
      ? (record.INFO as Record<string, unknown>)
      : record;
  if (record.INFO === false || info === null || typeof info !== "object") {
    return null;
  }

  const rawAgentId = typeof info.AgentID === "string" ? info.AgentID : "";
  const agentId = rawAgentId.trim();

  const buckets: TickeredBucket[] = BUCKET_RANGES.map(([low, high]) => {
    const playKey = `play${low}-${high}`;
    const colorKey = `color${low}-${high}`;
    const rawColor = info[colorKey];
    return {
      low,
      high,
      playKey,
      colorKey,
      playField: `play${high}`,
      colorField: `color${high}`,
      enabled: isFlagOn(
        typeof info[playKey] === "string" ? info[playKey] : null,
      ),
      color:
        typeof rawColor === "string" && HEX_COLOR.test(rawColor.trim())
          ? rawColor.trim().toLowerCase()
          : null,
    };
  });

  const known = new Set<string>([
    "AgentID",
    ...BUCKET_RANGES.flatMap(([low, high]) => [
      `play${low}-${high}`,
      `color${low}-${high}`,
    ]),
    ...Object.values(SHOW_FLAGS),
  ]);
  const unknownKeys = Object.keys(info).filter((key) => !known.has(key));

  return {
    agentId,
    agentIdPadded: rawAgentId.length > agentId.length,
    buckets,
    showHorses: isFlagOn(
      typeof info.showHorses === "string" ? info.showHorses : null,
    ),
    showIfbets: isFlagOn(
      typeof info.showIfbets === "string" ? info.showIfbets : null,
    ),
    showParlays: isFlagOn(
      typeof info.showParlays === "string" ? info.showParlays : null,
    ),
    showStraights: isFlagOn(
      typeof info.showStraights === "string" ? info.showStraights : null,
    ),
    showTeasers: isFlagOn(
      typeof info.showTeasers === "string" ? info.showTeasers : null,
    ),
    unknownKeys,
  };
}

export interface TickerWriteBody {
  /** Form-encoded body, in the observed field order. */
  readonly body: string;
  readonly fields: readonly (readonly [string, string])[];
}

/**
 * Builds the `updateBetTickerConfig` body from a parsed config.
 *
 * Upper-bound field names, `on`/`off` without padding (the write side does not pad), colours as
 * `#rrggbb`. The bucket fields are emitted in the portal's order — ascending — because a reordered
 * body is a different request.
 */
export function buildTickerConfigWrite(
  config: TickerConfig,
  options: { readonly agentOwner?: string } = {},
): TickerWriteBody {
  const fields: (readonly [string, string])[] = [["agentID", config.agentId]];

  // The observed write lists plays in descending order, then flags, then colours ascending.
  for (const bucket of [...config.buckets].reverse()) {
    fields.push([bucket.playField, bucket.enabled ? "on" : "off"]);
  }

  for (const key of [
    "showHorses",
    "showIfbets",
    "showTeasers",
    "showParlays",
    "showStraights",
  ] as const) {
    fields.push([key, config[key] ? "on" : "off"]);
  }

  for (const bucket of config.buckets) {
    fields.push([bucket.colorField, bucket.color ?? ""]);
  }

  fields.push(["operation", "updateBetTickerConfig"]);
  fields.push(["agentOwner", options.agentOwner ?? config.agentId]);

  return {
    body: new URLSearchParams(fields as [string, string][]).toString(),
    fields,
  };
}

/** Convenience for display: which buckets are on, as `1-499`-style labels. */
export function enabledBucketLabels(config: TickerConfig): string[] {
  return config.buckets
    .filter((bucket) => bucket.enabled)
    .map((bucket) => `${bucket.low}-${bucket.high}`);
}

/** Normalised flag for callers that want the string form without importing two modules. */
export function flagValue(raw: string | undefined | null): "on" | "off" | "" {
  const normalised = normalizeOnOffFlag(raw);
  return normalised === "on" || normalised === "off" ? normalised : "";
}
