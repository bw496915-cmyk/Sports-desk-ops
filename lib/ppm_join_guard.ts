/**
 * @file lib/ppm_join_guard.ts
 * @description Hard gate between the fixture snapshot and the odds feed.
 *
 * The two feeds are joined on `event_id` (unique leaf, no dedupe needed). The
 * *board* additionally groups by the feed's outer bucket. If the odds payload
 * used a different bucket identity space, every priced row would land on a
 * board row that the snapshot never produced — and nothing would error, because
 * the leaf join would still succeed.
 *
 * So this runs before any market logic and fails closed. A warning would be
 * skipped; a throw is what keeps a silent mismatch out.
 */

export type PpmJoinErrorCode = "slate_id_space_mismatch";

export class PpmJoinError extends Error {
  readonly code: PpmJoinErrorCode;

  constructor(code: PpmJoinErrorCode, message: string) {
    super(message);
    this.name = "PpmJoinError";
    this.code = code;
  }
}

export interface SlateSpaceOverlap {
  readonly overlap: number;
  readonly total: number;
  readonly ratio: number;
}

/**
 * Asserts that the odds feed's slate ids are (almost) all present in the
 * snapshot's. Empty odds input is a no-op: there is nothing to reconcile yet.
 *
 * @throws PpmJoinError when the overlap ratio is below `minOverlap`.
 */
export function assertSlateSpaceOverlap(
  snapshotSlateIds: Iterable<number>,
  oddsSlateIds: Iterable<number>,
  minOverlap = 0.95,
): SlateSpaceOverlap {
  if (!(minOverlap > 0 && minOverlap <= 1)) {
    throw new RangeError(`minOverlap must be in (0, 1] (got ${minOverlap})`);
  }

  const known = new Set<number>(snapshotSlateIds);
  const odds = new Set<number>(oddsSlateIds);
  if (odds.size === 0) return { overlap: 0, total: 0, ratio: 1 };

  let overlap = 0;
  for (const id of odds) if (known.has(id)) overlap += 1;
  const ratio = overlap / odds.size;

  if (ratio < minOverlap) {
    throw new PpmJoinError(
      "slate_id_space_mismatch",
      `ERR_SLATE_ID_SPACE_MISMATCH: ${overlap}/${odds.size} odds slate ids appear in the snapshot (${(ratio * 100).toFixed(1)}% < ${(minOverlap * 100).toFixed(0)}%)`,
    );
  }
  return { overlap, total: odds.size, ratio };
}
