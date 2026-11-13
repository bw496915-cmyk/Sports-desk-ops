/**
 * @file tests/ppm_desk_board.test.ts
 * @description Grouping contract: the snapshot is per betting event, the desk
 * board is per game, and no presentation data is invented on the way across.
 */
import { describe, expect, test } from "bun:test";
import { parsePpmAllEvents } from "../lib/ppm_live_feed.ts";
import { PPM_SPORT_NAMES, toDeskBoard } from "../lib/ppm_desk_board.ts";

const CROP = new URL("./fixtures/ppm/all-events.crop.json", import.meta.url);
const SNAPSHOT = parsePpmAllEvents(await Bun.file(CROP).json());
const BOARD = toDeskBoard(SNAPSHOT);

describe("toDeskBoard on the real crop", () => {
  test("groups betting events into games", () => {
    expect(BOARD.counts.games).toBeGreaterThan(0);
    expect(BOARD.counts.events).toBe(SNAPSHOT.fixtures.length);
    // The crop has a fixture carrying three betting events; grouping must
    // collapse it rather than emit three games.
    expect(BOARD.counts.games).toBeLessThan(BOARD.counts.events);
  });

  test("keeps a known game with its event ids", () => {
    const game = BOARD.games.find((candidate) => candidate.fixtureId === 9430);
    expect(game).toBeDefined();
    expect(game!.id).toBe("ppm:1:4:9430");
    expect(game!.sportId).toBe(1);
    expect(game!.sportName).toBe("Baseball");
    expect(game!.home.name).toBe("Great Britain");
    expect(game!.away.name).toBe("China");
    expect(game!.eventIds).toEqual([185442391]);
  });

  test("every game keeps at least one priced event and every event is linked", () => {
    const linked = BOARD.games.flatMap((game) => game.eventIds);
    expect(linked.length).toBe(BOARD.counts.events);
    expect(new Set(linked).size).toBe(linked.length);
    for (const game of BOARD.games) {
      expect(game.eventIds.length).toBeGreaterThan(0);
    }
  });

  test("game ids are unique and start with the source prefix", () => {
    const ids = BOARD.games.map((game) => game.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("ppm:")).toBe(true);
  });

  test("games are ordered by start time", () => {
    for (let i = 1; i < BOARD.games.length; i += 1) {
      const prev = BOARD.games[i - 1]!;
      const next = BOARD.games[i]!;
      expect(prev.startTimeUnix).toBeLessThanOrEqual(next.startTimeUnix);
    }
  });

  test("carries no invented markets or prices", () => {
    for (const game of BOARD.games) {
      expect("markets" in game).toBe(false);
      expect("prices" in game).toBe(false);
    }
  });
});

describe("window and name hygiene", () => {
  test("sinceUnix drops earlier games and their events", () => {
    const cutoff =
      SNAPSHOT.fixtures[Math.floor(SNAPSHOT.fixtures.length / 2)]!
        .startTimeUnix;
    const windowed = toDeskBoard(SNAPSHOT, { sinceUnix: cutoff });
    expect(windowed.counts.games).toBeLessThanOrEqual(BOARD.counts.games);
    expect(windowed.counts.events).toBeLessThan(BOARD.counts.events);
    for (const game of windowed.games) {
      expect(game.startTimeUnix).toBeGreaterThanOrEqual(cutoff);
    }
  });

  test("team names are trimmed without rewriting them", () => {
    const synthetic = parsePpmAllEvents({
      s: {
        1: {
          4: {
            9: {
              90: [
                ["  Athletics ", "", "", 1],
                ["Seattle  Mariners", "", "", 2],
                1_700_000_000,
              ],
            },
          },
        },
      },
    });
    const game = toDeskBoard(synthetic).games[0]!;
    expect(game.home.name).toBe("Athletics");
    expect(game.away.name).toBe("Seattle Mariners");
    expect(game.home.teamId).toBe(1);
  });
});

describe("sport labelling", () => {
  test("known sport ids resolve to a name", () => {
    expect(PPM_SPORT_NAMES[1]).toBe("Baseball");
    expect(PPM_SPORT_NAMES[5]).toBe("Soccer");
    expect(PPM_SPORT_NAMES[8]).toBe("Tennis");
  });

  test("an unknown sport id yields null, not a guess", () => {
    const synthetic = parsePpmAllEvents({
      s: {
        777: {
          12: {
            34: { 56: [["A", "", "", 1], ["B", "", "", 2], 1_700_000_000] },
          },
        },
      },
    });
    const board = toDeskBoard(synthetic);
    expect(board.games).toHaveLength(1);
    expect(board.games[0]!.sportName).toBeNull();
  });
});

describe("unresolved passthrough", () => {
  test("unresolved fixtures are counted but never become games", () => {
    const payload = {
      s: {
        1: {
          4: {
            1: { 11: [[""], [""], 1_700_000_000] },
            2: { 22: [["A", "", "", 1], ["B", "", "", 2], 1_700_000_100] },
          },
        },
      },
    };
    const board = toDeskBoard(parsePpmAllEvents(payload));
    expect(board.counts.games).toBe(1);
    expect(board.counts.events).toBe(1);
    expect(board.counts.unresolved).toBe(1);
    expect(board.games[0]!.eventIds).toEqual([22]);
  });
});
