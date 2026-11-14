/**
 * Observed getInfoPlayer response for BRT106 (2026-11-12).
 *
 * The fixture is redacted: credentials, customer name, contact fields and free-text notes are
 * absent, not blanked. The test checks the fields the dashboard reads, including `thisWeek`,
 * which is an object in this response (the parser used to type it as boolean).
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  parseGetInfoPlayerEnvelope,
  redactGetInfoPlayer,
  summarizeGetInfoPlayer,
  type GetInfoPlayerEnvelope,
} from "../lib/f402_get_info_player.ts";

const FIXTURE = resolve(
  import.meta.dir,
  "fixtures/f402-get-info-player-brt106-2026-11-12.redacted.json",
);

describe("observed getInfoPlayer response", () => {
  it("summarizes balances, limits and the previous week", async () => {
    const raw = (await Bun.file(FIXTURE).json()) as unknown;
    const envelope = parseGetInfoPlayerEnvelope(raw);
    const summary = summarizeGetInfoPlayer(envelope);

    expect(summary.customerId).toBe("BRT106");
    expect(summary.login).toBe("BRT106");
    expect(summary.agentId).toBe("BGMASTER");
    expect(summary.active).toBe("Y");
    expect(summary.creditLimit).toBe(7_500_000);
    expect(summary.currentBalance).toBe(-205_000);
    expect(summary.availableBalance).toBe(4_735_000);
    expect(summary.pendingWagerBalance).toBe(2_560_000);
    expect(summary.pendingWagerCount).toBe(4);
    expect(summary.carryOverAmount).toBe(7_932_500);
    expect(summary.settleFigure).toBe(25_000);
    expect(summary.wagerLimit).toBe(1_000_000);
    expect(summary.suspectedBot).toBe("N");
    expect(summary.previousBalance).toBe(79_325);
    expect(summary.parlaySpecCount).toBe(18);
  });

  it("carries no credential or PII value", async () => {
    const text = await Bun.file(FIXTURE).text();
    expect(/"Password"\s*:/.test(text)).toBe(false);
    expect(/"Passwordt"\s*:/.test(text)).toBe(false);
    expect(/"NameFirst"\s*:/.test(text)).toBe(false);
    expect(/"email"\s*:/.test(text)).toBe(false);
  });

  it("redacts credentials and PII when asked", () => {
    const envelope = {
      INFO: {
        data: { Login: "X", Password: "secret", NameFirst: "Ada" },
        added: { CustomerID: "X", TelegramID: "123" },
      },
    } as unknown as GetInfoPlayerEnvelope;
    const redacted = redactGetInfoPlayer(envelope);
    expect(redacted.INFO.data.Password).toBe("<redacted>");
    expect(redacted.INFO.data.NameFirst).toBe("<redacted>");
    expect(redacted.INFO.added?.TelegramID).toBe("<redacted>");
  });

  it("treats a legacy boolean thisWeek as no previous balance", async () => {
    const raw = (await Bun.file(FIXTURE).json()) as Record<string, unknown>;
    const info = { ...(raw.INFO as Record<string, unknown>), thisWeek: true };
    const summary = summarizeGetInfoPlayer(
      parseGetInfoPlayerEnvelope({ ...raw, INFO: info }),
    );
    expect(summary.previousBalance).toBeNull();
  });
});
