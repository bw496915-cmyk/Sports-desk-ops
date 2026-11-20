/**
 * @file tests/rbac_scope_retention.test.ts
 * @description Regression guard for the Bun v1.4.1 AsyncLocalStorage leak:
 * a timer created inside a nested scope must not keep the OUTER scope's
 * metadata alive after the timer fires and the scopes end.
 *
 * Bun v1.4.2 fixed the leak (timers/immediates/promises created inside
 * `store.exit()` or a nested `store.run()` retained the outer store); the
 * repository pin includes the fix, and this test keeps a wrapper regression
 * from reintroducing it.
 */

import { describe, expect, test } from "bun:test";

import {
  currentRbacScope,
  runWithRbacScope,
  type RbacScope,
} from "../src/lib/rbac_scope.ts";

/** Force a full collection several times so async-resource cleanup can settle. */
async function collectGarbage(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    Bun.gc(true);
    await Bun.sleep(0);
  }
}

interface ScheduledTimer {
  readonly payloadRef: WeakRef<object>;
  readonly done: Promise<void>;
}

function scheduleTimerInNestedScope(): ScheduledTimer {
  const payload = {
    marker: "outer-scope-metadata",
    rows: Array.from({ length: 256 }, () => 0),
  };
  const payloadRef = new WeakRef(payload);
  const outer: RbacScope = {
    actorId: "outer-actor",
    roles: ["ops"],
    metadata: payload,
  };
  const inner: RbacScope = { actorId: "inner-actor", roles: ["viewer"] };

  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  runWithRbacScope(outer, () => {
    runWithRbacScope(inner, () => {
      // The timer is created in the INNER scope. The v1.4.1 bug kept the
      // OUTER store (and therefore `outer.metadata`) alive until it fired.
      setTimeout(() => resolveDone?.(), 5);
    });
  });

  return { payloadRef, done };
}

/** Module-level holder proving WeakRef can observe a retained payload. */
export let controlRetained: object | undefined;

function retainPayload(): WeakRef<object> {
  const payload = { marker: "retained-on-purpose" };
  controlRetained = payload;
  return new WeakRef(payload);
}

describe("runWithRbacScope retention", () => {
  test("the inner scope is the one visible to the timer", async () => {
    let seenInsideTimer: string | undefined;
    await new Promise<void>((resolve) => {
      runWithRbacScope({ actorId: "outer", roles: ["ops"] }, () => {
        runWithRbacScope({ actorId: "inner", roles: ["viewer"] }, () => {
          setTimeout(() => {
            seenInsideTimer = currentRbacScope()?.actorId;
            resolve();
          }, 0);
        });
      });
    });

    expect(seenInsideTimer).toBe("inner");
  });

  test("a nested-scope timer does not retain the outer metadata", async () => {
    const { payloadRef, done } = scheduleTimerInNestedScope();
    await done;
    await collectGarbage();

    expect(payloadRef.deref()).toBeUndefined();
  });

  test("control: WeakRef observes both retention and release", async () => {
    const payloadRef = retainPayload();
    await collectGarbage();
    expect(payloadRef.deref()).toBeDefined();

    controlRetained = undefined;
    await collectGarbage();
    expect(payloadRef.deref()).toBeUndefined();
  });
});
