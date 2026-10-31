import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FEED_PATH = join(import.meta.dirname, "..", "docs", "graph-live-feed.json");

interface Feed {
  schemaVersion?: number;
  dataMode?: string;
  wssIngestion?: string;
  activeSyndicateWalletsCount?: number;
  configuredWalletsCount?: number;
  provenance?: {
    polymarket?: Record<string, unknown> & { walletsInvalid?: number; walletsStale?: number };
    f402?: Record<string, unknown>;
  };
  liveTicks?: unknown[];
  walletProfiles?: Array<Record<string, unknown>>;
}

const feed = JSON.parse(readFileSync(FEED_PATH, "utf8")) as Feed;

describe("graph-live-feed contract (schema 3)", () => {
  test("declares schema 3, a valid dataMode, and honest WSS fields", () => {
    expect(feed.schemaVersion).toBe(3);
    expect(["LIVE", "PARTIAL", "FIXTURE"]).toContain(feed.dataMode);
    expect(feed.wssIngestion).toBe("not_ingested");
    expect(typeof feed.activeSyndicateWalletsCount).toBe("number");
    expect(feed.configuredWalletsCount).toBe(39);
  });

  test("publishes provenance counts and a liveTicks array", () => {
    const pm = feed.provenance?.polymarket;
    expect(pm).toBeDefined();
    if (pm !== undefined && pm["source"] !== "fixture") {
      for (const key of ["walletsRequested", "walletsOk", "walletsFailed", "walletsStale", "walletsInvalid"]) {
        expect(typeof pm[key]).toBe("number");
      }
    }
    expect(Array.isArray(feed.liveTicks)).toBe(true);
    expect(feed.provenance?.f402).toBeDefined();
  });

  test("every wallet carries provenance and quarantined rows hold no exposure", () => {
    const wallets = feed.walletProfiles ?? [];
    expect(wallets).toHaveLength(39);
    for (const wallet of wallets) {
      expect(["LIVE", "STALE", "FIXTURE"]).toContain(String(wallet["dataSource"]));
      expect(typeof wallet["walletAddressValid"]).toBe("boolean");
      if (wallet["walletAddressValid"] === false) {
        expect(wallet["openVolumeUsd"]).toBe(0);
        expect(wallet["openLegsCount"]).toBe(0);
        expect(String(wallet["lastError"])).toContain("invalid address");
      }
    }
  });

  test("contains no NaN/Infinity numeric leaks", () => {
    const walk = (value: unknown): void => {
      if (typeof value === "number") {
        expect(Number.isFinite(value)).toBe(true);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value !== null && typeof value === "object") {
        Object.values(value as Record<string, unknown>).forEach(walk);
      }
    };
    walk(feed);
  });
});
