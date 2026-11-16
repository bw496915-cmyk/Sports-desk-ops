import { describe, expect, test } from "bun:test";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";

describe("terminal profile live book resolve", () => {
  test("profile DCC306 --radar uses data/live-wagers.json", async () => {
    const radarRes = await executeTerminalQuery("profile DCC306 --radar");
    expect(radarRes.exitCode).toBe(0);
    expect(radarRes.stdout).toContain("SHARPNESS RADAR DECOMPOSITION");
    expect(radarRes.stdout).toContain("DCC306");
  });
});