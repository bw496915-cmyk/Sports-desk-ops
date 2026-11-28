/**
 * @file tests/kill_escalation.test.ts
 * @description Guards for the standalone SIGTERM -> SIGKILL helper: one signal per
 * phase, and no SIGKILL once the owner has observed the child exit.
 */

import { expect, test } from "bun:test";

import { createKillEscalation } from "../lib/kill_escalation.ts";

function recorder(): { signals: string[]; proc: { kill(s: string): void } } {
  const signals: string[] = [];
  return {
    signals,
    proc: {
      kill(signal: string): void {
        signals.push(signal);
      },
    },
  };
}

test("sends SIGTERM once, then SIGKILL once after the grace period", async () => {
  const { signals, proc } = recorder();
  const escalation = createKillEscalation(proc as never, { graceMs: 10 });

  escalation.terminate();
  escalation.terminate();
  await Bun.sleep(40);

  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(escalation.escalated).toBe(true);
});

test("markExited before the grace cancels the SIGKILL", async () => {
  const { signals, proc } = recorder();
  const escalation = createKillEscalation(proc as never, { graceMs: 10 });

  escalation.terminate();
  escalation.markExited();
  await Bun.sleep(40);

  expect(signals).toEqual(["SIGTERM"]);
  expect(escalation.escalated).toBe(false);
});

test("rejects a negative grace period", () => {
  const { proc } = recorder();
  expect(() => createKillEscalation(proc as never, { graceMs: -1 })).toThrow(
    "ERR_KILL_GRACE_INVALID",
  );
});
