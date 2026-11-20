import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, test } from "bun:test";

async function waitForCollection(reference: WeakRef<object>): Promise<boolean> {
  // Dereferencing keeps the target alive until the current job ends.
  for (let attempt = 0; attempt < 30; attempt++) {
    await Bun.sleep(5);
    Bun.gc(true);
    if (reference.deref() === undefined) return true;
  }
  return false;
}

// https://github.com/oven-sh/bun/commit/74326db585fe67c2a02bef1119c9e54ab05addf9
describe("AsyncLocalStorage GC retention", () => {
  for (const mode of ["nested-run", "exit"] as const) {
    test(`${mode} does not retain the outer store through a pending timer`, async () => {
      const storage = new AsyncLocalStorage<{ payload: Uint8Array }>();
      function scheduleTimer() {
        const outer = { payload: new Uint8Array(64 * 1024) };
        const reference = new WeakRef(outer);
        const timer = storage.run(outer, () => {
          const schedule = () => setTimeout(() => {}, 3_600_000);
          return mode === "exit"
            ? storage.exit(schedule)
            : storage.run({ payload: new Uint8Array(8) }, schedule);
        });
        return { reference, timer };
      }
      const { reference, timer } = scheduleTimer();
      try {
        expect(await waitForCollection(reference)).toBe(true);
      } finally {
        clearTimeout(timer);
        storage.disable();
      }
    });
  }
});
