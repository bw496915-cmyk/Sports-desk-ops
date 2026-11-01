import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseShortDesc,
  readWagerList,
  summarizeLiveWagers,
  toLiveWager,
  writerOf,
  type LiveWager,
} from "./live_wagers.ts";

const payload = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../tests/fixtures/live-wagers-list-sample.json"),
    "utf8",
  ),
);

const wagers = readWagerList(payload);

describe("readWagerList", () => {
  test("accepts the {LIST: [...]} envelope", () => {
    expect(wagers).toHaveLength(7);
  });

  test("accepts a bare array and skips rows without a WagerNumber", () => {
    const list = (payload as { LIST: unknown[] }).LIST;
    expect(readWagerList(list)).toHaveLength(7);
    expect(readWagerList([{ AgentID: "X" }, ...list.slice(0, 1)])).toHaveLength(
      1,
    );
  });

  test("returns nothing for unrelated payloads", () => {
    expect(readWagerList(null)).toEqual([]);
    expect(readWagerList({ ok: true })).toEqual([]);
  });

  test("trims padded identifiers", () => {
    const first = wagers[0] as LiveWager;
    expect(first.customerId).toBe("WC9001.");
    expect(first.agentLogin).toBe("ADAM");
    expect(first.login).toBe("WC9001");
  });

  test("keeps WagerType raw instead of renaming an unknown code", () => {
    // "M" has no documented meaning in this repository; inventing a name would be a guess.
    const moneylineish = wagers.filter((wager) => wager.wagerType === "M");
    expect(moneylineish.length).toBeGreaterThan(0);
    expect(new Set(wagers.map((wager) => wager.wagerType))).toEqual(
      new Set(["P", "M", "S"]),
    );
  });
});

describe("writerOf", () => {
  test("classifies the four observed channels", () => {
    expect(writerOf("GSLIVE                                            ")).toBe(
      "gslive",
    );
    expect(writerOf("GSBUILDER                                         ")).toBe(
      "gsbuilder",
    );
    expect(writerOf("Internet                                          ")).toBe(
      "internet",
    );
    expect(writerOf("ALERT                                             ")).toBe(
      "alert",
    );
  });

  test("anything else is other, not a guess", () => {
    expect(writerOf("")).toBe("other");
    expect(writerOf("KIOSK")).toBe("other");
  });
});

describe("parseShortDesc", () => {
  test("splits a parlay into one leg per selection", () => {
    const { legs, descCode } = parseShortDesc(
      "P.G319747616\r\nFootball - Los Angeles Rams vs Los Angeles Chargers / Game / Winner (2 way) / Los Angeles Rams -140&#x0D;\nFootball - Miami Dolphins vs New England Patriots / Game / Winner (2 way) / New England Patriots -252&#x0D;\n",
    );
    expect(descCode).toBe("P.G319747616");
    expect(legs).toHaveLength(2);
    expect(legs[0]).toEqual({
      sport: "Football",
      game: "Los Angeles Rams vs Los Angeles Chargers",
      period: "Game",
      market: "Winner (2 way)",
      pick: "Los Angeles Rams -140",
      raw: "Football - Los Angeles Rams vs Los Angeles Chargers / Game / Winner (2 way) / Los Angeles Rams -140",
      compact: false,
    });
  });

  test("parses a straight bet with the code inline", () => {
    const { legs, descCode } = parseShortDesc(
      "S:Basketball #540 Warriors -2 -110 - For Game ",
    );
    expect(descCode).toBe("S");
    expect(legs).toHaveLength(1);
    // The alert line uses the compact grammar (`Sport #rot Team line - For Game`), not the
    // `/ Period / Market / Pick` one, so only sport and game survive the split.
    expect(legs[0]?.sport).toBe("Basketball");
    expect(legs[0]?.pick).toBe("#540 Warriors -2 -110 - For Game");
    expect(legs[0]?.period).toBe("");
    expect(legs[0]?.market).toBe("");
    expect(legs[0]?.compact).toBe(true);
  });

  test("handles an escaped newline form and &#x0D artefacts", () => {
    const { legs } = parseShortDesc(
      "M.G319749023\\r\\nTennis - Stiles Brockett vs Emile Hudd / Match / Winner (2 way) / Emile Hudd -236&#x0D;\\n",
    );
    expect(legs).toHaveLength(1);
    expect(legs[0]?.sport).toBe("Tennis");
    expect(legs[0]?.period).toBe("Match");
  });

  test("keeps a pick that itself contains slashes", () => {
    const { legs } = parseShortDesc(
      "M.G1\r\nFootball - A vs B / Game / Market / Over 11.5 / and more",
    );
    expect(legs[0]?.pick).toBe("Over 11.5 / and more");
  });

  test("empty description yields no legs", () => {
    expect(parseShortDesc("")).toEqual({ legs: [], descCode: null });
    expect(parseShortDesc(null)).toEqual({ legs: [], descCode: null });
  });
});

describe("volume vs amount", () => {
  test("flags the Internet bet where volume is below the stake", () => {
    const riverrat = wagers.find((wager) => wager.wagerNumber === 767126231);
    expect(riverrat?.amountWagered).toBe(3500);
    expect(riverrat?.volumeAmount).toBe(2188);
    expect(riverrat?.volumeDiffers).toBe(true);
  });

  test("flags the alert bet with zero volume", () => {
    const alert = wagers.find((wager) => wager.writer === "alert");
    expect(alert?.volumeAmount).toBe(0);
    expect(alert?.volumeDiffers).toBe(true);
  });

  test("equal amounts are not flagged", () => {
    const gslive = wagers.find((wager) => wager.wagerNumber === 767126203);
    expect(gslive?.volumeDiffers).toBe(false);
  });
});

describe("toLiveWager", () => {
  test("keeps amounts in integer dollars as the feed reports them", () => {
    const wager = toLiveWager(
      (payload as { LIST: Record<string, unknown>[] }).LIST[1]!,
    );
    expect(wager.amountWagered).toBe(21600);
    expect(wager.toWinAmount).toBe(20000);
  });

  test("VIP flag treats the padded '0' as false", () => {
    const wager = wagers[0] as LiveWager;
    expect(wager.vip).toBe(false);
    expect(toLiveWager({ WagerNumber: 1, VIP: "1" }).vip).toBe(true);
  });
});

describe("summarizeLiveWagers", () => {
  const summary = summarizeLiveWagers(wagers);

  test("totals the stakes, payouts and volume", () => {
    expect(summary.count).toBe(7);
    expect(summary.risk).toBe(1000 + 21600 + 7277 + 3500 + 1430 + 1600 + 3000);
    expect(summary.toWin).toBe(1395 + 20000 + 20001 + 5878 + 1300 + 678 + 3542);
  });

  test("counts by writer, type and leg sport", () => {
    expect(summary.byWriter).toEqual({
      gslive: 4,
      internet: 1,
      alert: 1,
      gsbuilder: 1,
    });
    expect(summary.byType).toEqual({ P: 3, M: 2, S: 2 });
    expect(summary.bySport).toEqual({
      Football: 7,
      Basketball: 4,
      Tennis: 1,
    });
  });

  test("counts legs across parlays", () => {
    // 2 + 1 + 3 + 1 + 1 + 1 + 3
    expect(summary.legs).toBe(12);
  });

  test("counts volume mismatches", () => {
    expect(summary.volumeMismatches).toBe(2);
  });

  test("no VIP rows in this sample", () => {
    expect(summary.vip).toBe(0);
  });

  test("handles an empty list", () => {
    expect(summarizeLiveWagers([])).toEqual({
      count: 0,
      risk: 0,
      toWin: 0,
      volume: 0,
      vip: 0,
      volumeMismatches: 0,
      byWriter: {},
      byType: {},
      bySport: {},
      legs: 0,
    });
  });
});
