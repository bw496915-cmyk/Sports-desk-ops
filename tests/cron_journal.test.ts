import { describe, expect, test } from "bun:test";
import {
  formatRun,
  parseCronJournal,
  parseCronJournalChunk,
} from "../lib/cron_journal.ts";

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

    const chunk = parseCronJournalChunk(text);
    expect(chunk.runs).toHaveLength(2);
    expect(chunk.runs[1]?.ok).toBe(false);
    expect(chunk.runs[1]?.exitCode).toBe(1);
    expect(chunk.done).toBe(false);
    expect(chunk.hasPartialOrInvalidTail).toBe(true);
  });

  test("an incomplete first line or empty journal yields no runs without throwing", () => {
    expect(parseCronJournal("")).toEqual([]);
    // Bun.JSONL.parse throws SyntaxError when 0 values precede a partial line;
    // parseCronJournalChunk uses Bun.JSONL.parseChunk so it never throws.
    const partialFirst = parseCronJournalChunk('{"at":"2026-11-01');
    expect(partialFirst.runs).toEqual([]);
    expect(partialFirst.done).toBe(false);
    expect(partialFirst.hasPartialOrInvalidTail).toBe(true);
  });

  test("accepts Uint8Array input (including UTF-8 BOM)", () => {
    const line = `${JSON.stringify({
      at: "2026-11-01T06:00:00Z",
      ok: true,
      exitCode: 0,
      durationMs: 50,
      mode: "offline",
    })}\n`;
    const body = new TextEncoder().encode(line);
    const withBom = new Uint8Array(3 + body.byteLength);
    withBom.set([0xef, 0xbb, 0xbf], 0);
    withBom.set(body, 3);
    const runs = parseCronJournal(withBom);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.durationMs).toBe(50);
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
