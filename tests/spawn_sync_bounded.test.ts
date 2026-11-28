/**
 * @file tests/spawn_sync_bounded.test.ts
 * @description The guardrail defaults on the blocking spawn wrapper: a normal
 * command passes through, a hang is killed at the timeout, and a chatty child is
 * stopped at the output cap.
 */

import { expect, test } from "bun:test";

import { spawnSyncBounded } from "../lib/spawn_sync_bounded.ts";

test("passes a normal command through with its output", () => {
  const result = spawnSyncBounded(["echo", "bounded"], { stdout: "pipe" });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("bounded");
});

test("accepts the object form", () => {
  const result = spawnSyncBounded({
    cmd: ["echo", "object-form"],
    stdout: "pipe",
  });

  expect(result.stdout.toString()).toContain("object-form");
});

test("kills a hang at the timeout and reports exitedDueToTimeout", () => {
  const startedAt = Date.now();
  const result = spawnSyncBounded(["sleep", "5"], { timeout: 50 });

  expect(result.exitedDueToTimeout).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});

test("bounds output with maxBuffer", () => {
  const command = [
    process.execPath,
    "-e",
    "process.stdout.write('x'.repeat(100000))",
  ];
  const control = spawnSyncBounded(command, { stdout: "pipe" });
  const capped = spawnSyncBounded(command, {
    stdout: "pipe",
    maxBuffer: 1_024,
  });

  expect(control.stdout.length).toBe(100_000);
  expect(capped.stdout.length).toBeLessThan(control.stdout.length);
});
