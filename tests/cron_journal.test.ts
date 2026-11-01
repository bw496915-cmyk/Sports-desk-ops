import { describe, expect, test } from "bun:test";
import { formatRun, parseCronJournal } from "../lib/cron_journal.ts";

describe("artifact cron journal", () => {
  test("parses valid lines and ignores malformed or partial ones", () => {
    const text = [
      JSON.stringify({
        at: "2026-11-01T06:00:00Z",
        ok: true,
        exitCode: 0,
        durationMs: 1200,
        mode: "offline",
      }),
      JSON.stringify({
        at: "2026-11-02T06:00:00Z",
        ok: false,
        exitCode: 1,
        durationMs: 300,
        mode: "offline",
      }),
      JSON.stringify({ at: "2026-11-03T06:00:00Z", ok: "yes" }),
      '{"at":"2026-11-04T06:00:00Z","ok":tr',
    ].join("\n");

    const runs = parseCronJournal(text);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.ok).toBe(false);
    expect(runs[1]?.exitCode).toBe(1);
  });

  test("an empty journal yields no runs", () => {
    expect(parseCronJournal("")).toEqual([]);
  });

  test("formats a run without implying success", () => {
    expect(
      formatRun({
        at: "2026-11-01T06:00:00Z",
        ok: true,
        exitCode: 0,
        durationMs: 12,
        mode: "live",
      }),
    ).toBe("2026-11-01T06:00:00Z  live    ok             12 ms");
    expect(
      formatRun({
        at: "2026-11-01T06:00:00Z",
        ok: false,
        exitCode: 2,
        durationMs: 12,
        mode: "offline",
      }),
    ).toContain("failed(2)");
  });
});
