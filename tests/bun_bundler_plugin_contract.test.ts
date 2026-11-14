import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bun 1.4.4 lifecycle semantics for bundler plugins, measured 2026-11-14 against
 * the "Plugins" reference. Two of these contradict the published page:
 *
 *  - The page says onStart callbacks "cannot modify the build.config object".
 *    Measured: assigning build.config.outdir inside onStart DID take effect (the
 *    output landed in the mutated directory). This test pins the version we ship
 *    on, not the page.
 *  - The page's onLoad result type includes `exports`, but 1.4.4 rejects it with
 *    "onLoad plugins must return an object with \"contents\" as a string or
 *    Uint8Array". That assertion is a ratchet: when Bun gains support, this test
 *    fails and the slab guard can be revisited.
 *
 * Also pinned: onStart is awaited before the build proceeds; onEnd sees the
 * result but a returned { errors } is ignored; defer() may be called only once
 * per onLoad invocation.
 */

function project() {
  const root = mkdtempSync(join(tmpdir(), "plugin-contract-"));
  writeFileSync(join(root, "entry.ts"), "export const x = 1;\n");
  return root;
}

describe("Bun bundler plugin lifecycle (1.4.4)", () => {
  test("onStart is awaited before building", async () => {
    const root = project();
    const marks: string[] = [];
    try {
      const started = performance.now();
      const result = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        plugins: [
          {
            name: "awaited-start",
            setup(build) {
              build.onStart(async () => {
                marks.push("begin");
                await Bun.sleep(40);
                marks.push("end");
              });
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(marks).toEqual(["begin", "end"]);
      expect(performance.now() - started).toBeGreaterThanOrEqual(30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("onStart CAN mutate build.config on 1.4.4 (docs say it cannot)", async () => {
    const root = project();
    const target = join(root, "mutated-out");
    try {
      const result = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "original-out"),
        plugins: [
          {
            name: "mutating-start",
            setup(build) {
              build.onStart(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (build.config as any).outdir = target;
              });
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.outputs[0]?.path.startsWith(target)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("onEnd sees the result; a returned { errors } is ignored", async () => {
    const root = project();
    let sawOutputs = -1;
    try {
      const result = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        plugins: [
          {
            name: "end-hook",
            setup(build) {
              build.onEnd((completion) => {
                sawOutputs = completion.outputs.length;
                // The 1.4.4 type returns void; this return value is ignored.
                return { errors: [new Error("onEnd-injected")] } as never;
              });
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(sawOutputs).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("defer() may be called only once per onLoad", async () => {
    const root = project();
    try {
      const error = (await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        plugins: [
          {
            name: "double-defer",
            setup(build) {
              build.onLoad({ filter: /entry\.ts$/ }, async ({ defer }) => {
                void defer();
                void defer();
                return { contents: "export const x = 2;", loader: "js" };
              });
            },
          },
        ],
      }).catch((e: unknown) => e)) as AggregateError;
      expect(error).toBeInstanceOf(AggregateError);
      const details = [...(error.errors ?? [])]
        .map((e) => (e as Error).message)
        .join("; ");
      expect(details).toContain("more than once");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("onLoad `exports` is rejected on 1.4.4 (ratchet)", async () => {
    const root = project();
    try {
      const error = (await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        plugins: [
          {
            name: "exports-shape",
            setup(build) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              build.onLoad({ filter: /entry\.ts$/ }, () => ({ exports: { x: 1 } }) as any);
            },
          },
        ],
      }).catch((e: unknown) => e)) as AggregateError;
      expect(error).toBeInstanceOf(AggregateError);
      const details = [...(error.errors ?? [])]
        .map((e) => (e as Error).message)
        .join("; ");
      expect(details).toContain("contents");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
