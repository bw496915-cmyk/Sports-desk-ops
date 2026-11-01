import { describe, expect, test } from "bun:test";
import {
  type ArtifactsLock,
  buildLock,
  parseLock,
  verifyLock,
} from "../lib/artifacts_lock.ts";

const LOCK: ArtifactsLock = {
  version: 1,
  artifacts: {
    "docs/a.json": { sha256: "a".repeat(64), bytes: 10 },
    "docs/b.json": { sha256: "b".repeat(64), bytes: 20 },
  },
  inputs: {
    "lib/x.ts": "c".repeat(64),
    "lib/y.ts": "d".repeat(64),
  },
};

describe("artifacts lock", () => {
  test("round-trips and rejects malformed documents", () => {
    expect(parseLock(LOCK)).toEqual(LOCK);
    expect(() => parseLock({ version: 2 })).toThrow("version");
    expect(() => parseLock({ version: 1 })).toThrow("artifacts");
    expect(() =>
      parseLock({ version: 1, artifacts: {}, inputs: { "lib/x.ts": "nope" } }),
    ).toThrow("no sha256");
    expect(() =>
      parseLock({
        version: 1,
        artifacts: { x: { sha256: "a".repeat(64) } },
        inputs: {},
      }),
    ).toThrow("bytes");
  });

  test("accepts an unchanged tree", () => {
    expect(verifyLock(LOCK, LOCK)).toEqual([]);
  });

  test("flags a hand-edited artifact", () => {
    const edited = {
      ...LOCK,
      artifacts: {
        ...LOCK.artifacts,
        "docs/a.json": { sha256: "e".repeat(64), bytes: 11 },
      },
    };
    expect(verifyLock(LOCK, edited)).toContain(
      "docs/a.json changed since it was locked; regenerate and run --update",
    );
  });

  test("flags an input that changed without regeneration", () => {
    const drifted = {
      ...LOCK,
      inputs: { ...LOCK.inputs, "lib/x.ts": "f".repeat(64) },
    };
    expect(verifyLock(LOCK, drifted)).toContain(
      "lib/x.ts changed since the artifacts were generated; rerun artifacts:value",
    );
  });

  test("flags missing and unrecorded files", () => {
    const missing = {
      ...LOCK,
      artifacts: { "docs/b.json": LOCK.artifacts["docs/b.json"]! },
    };
    expect(verifyLock(LOCK, missing)).toContain(
      "docs/a.json is locked but missing from the tree",
    );

    const extra = {
      ...LOCK,
      artifacts: {
        ...LOCK.artifacts,
        "docs/c.json": { sha256: "1".repeat(64), bytes: 1 },
      },
      inputs: { ...LOCK.inputs, "lib/z.ts": "2".repeat(64) },
    };
    const errors = verifyLock(LOCK, extra);
    expect(errors).toContain(
      "docs/c.json is not in the lock; run --update after regenerating",
    );
    expect(errors).toContain("lib/z.ts is not in the lock; run --update");
  });

  test("the committed lock matches the current tree", async () => {
    const recorded = parseLock(
      await Bun.file("docs/artifacts.lock.json").json(),
    );
    expect(verifyLock(recorded, await buildLock())).toEqual([]);
  });
});
