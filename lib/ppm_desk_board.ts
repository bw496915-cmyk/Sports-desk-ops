/**
 * @file lib/ppm_desk_board.ts
 * @description Projects a PPM fixture snapshot into desk games.
 *
 * The snapshot is per *betting event*; the desk board is per *game*. One game
 * carries several priced events (periods, markets), so this groups by
 * `(sportId, leagueId, fixtureId)` and keeps the event ids as the link the
 * odds feed will fill in.
 *
 * What this deliberately does not do: invent prices, colours or form. A game
 * with no odds yet is a game with `eventIds` and no markets — the dashboard
 * layer decides how to render that, and must not be handed synthetic numbers.
 */

import type {
  PpmAllEventsSnapshot,
  PpmFixture,
  PpmTeam,
} from "./ppm_live_feed.ts";

/**
 * Sport ids observed on the live snapshot (2026-11-12), identified from team
 * names rather than from `sportOrder`. Partial by design: the snapshot carries
 * 35 sports; the rest resolve to `null` and the caller decides how to label
 * them. Do not renumber from the menu order — menu ids are not sport ids.
 */
export const PPM_SPORT_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "Baseball",
  2: "Basketball",
  3: "American Football",
  4: "Ice Hockey",
  5: "Soccer",
  6: "Boxing",
  7: "Golf",
  8: "Tennis",
  9: "Motor Racing",
  86: "Handball",
  89: "Futsal",
});

export interface DeskGame {
  /** Stable, source-qualified id: `ppm:<sportId>:<leagueId>:<fixtureId>`. */
  readonly id: string;
  readonly fixtureId: number;
  readonly sportId: number;
  readonly sportName: string | null;
  readonly leagueId: number;
  readonly home: PpmTeam;
  readonly away: PpmTeam;
  readonly startTimeUnix: number;
  /** Betting events under this game, ascending. Empty is impossible here. */
  readonly eventIds: readonly number[];
}

export interface DeskBoardOptions {
  /** Drop games starting before this epoch second (e.g. now, for a live board). */
  readonly sinceUnix?: number;
}

export interface DeskBoard {
  readonly games: readonly DeskGame[];
  readonly counts: {
    readonly games: number;
    readonly events: number;
    readonly unresolved: number;
  };
}

const BOARD_PREFIX = "ppm";

/** Feed names carry stray padding (`" Athletics"`); presentation normalises it. */
function tidyName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function gameKey(fixture: PpmFixture): string {
  return `${fixture.sportId}:${fixture.leagueId}:${fixture.fixtureId}`;
}

export function toDeskBoard(
  snapshot: PpmAllEventsSnapshot,
  options: DeskBoardOptions = {},
): DeskBoard {
  const sinceUnix = options.sinceUnix ?? Number.NEGATIVE_INFINITY;
  const grouped = new Map<string, PpmFixture[]>();
  for (const fixture of snapshot.fixtures) {
    if (fixture.startTimeUnix < sinceUnix) continue;
    const key = gameKey(fixture);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(fixture);
    else grouped.set(key, [fixture]);
  }

  const games: DeskGame[] = [];
  let events = 0;
  for (const bucket of grouped.values()) {
    const first = bucket[0]!;
    const eventIds = bucket
      .map((fixture) => fixture.eventId)
      .sort((a, b) => a - b);
    events += eventIds.length;
    games.push({
      id: `${BOARD_PREFIX}:${first.sportId}:${first.leagueId}:${first.fixtureId}`,
      fixtureId: first.fixtureId,
      sportId: first.sportId,
      sportName: PPM_SPORT_NAMES[first.sportId] ?? null,
      leagueId: first.leagueId,
      home: { name: tidyName(first.home.name), teamId: first.home.teamId },
      away: { name: tidyName(first.away.name), teamId: first.away.teamId },
      startTimeUnix: first.startTimeUnix,
      eventIds,
    });
  }

  games.sort(
    (a, b) => a.startTimeUnix - b.startTimeUnix || a.id.localeCompare(b.id),
  );

  return {
    games,
    counts: {
      games: games.length,
      events,
      unresolved: snapshot.unresolved.length,
    },
  };
}
