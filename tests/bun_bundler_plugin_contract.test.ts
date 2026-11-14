import { describe, expect, test } from "bun:test";
import type { Loader } from "bun";
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
 *  - The page's onLoad result type shows `exports` as a plain optional field.
 *    1.4.4 requires the `loader: "object"` discriminator alongside it; without
 *    that the build fails with "onLoad plugins must return an object with
 *    \"contents\" as a string or Uint8Array". Both shapes are pinned below.
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
  test("onLoad args carry namespace/loader; the Loader union is accepted", async () => {
    // The page's onLoad callback type shows only { path, defer }; installed
    // bun-types also pass namespace and the default loader, measured here.
    const loads: Array<{ namespace: string; loader: string }> = [];
    // Typed against Bun's own Loader union: the published page omits "xml", but
    // installed bun-types 1.4.4 include it and this repo imports XML fixtures with
    // { type: "xml" }. If Bun ever drops the name, this line fails to compile.
    const loaders: readonly Loader[] = [
      "js",
      "jsx",
      "ts",
      "tsx",
      "json",
      "jsonc",
      "toml",
      "yaml",
      "xml",
      "file",
      "text",
      "css",
      "html",
    ];
    const root = project();
    writeFileSync(
      join(root, "entry.ts"),
      'import * as ns from "virt";\nconsole.log(Object.keys(ns).length);\n',
    );
    try {
      for (const loader of loaders) {
        const result = await Bun.build({
          entrypoints: [join(root, "entry.ts")],
          outdir: join(root, `out-${loader}`),
          plugins: [
            {
              name: `loader-${loader}`,
              setup(build) {
                build.onResolve({ filter: /^virt$/ }, () => ({
                  path: "virt",
                  namespace: "v",
                }));
                build.onLoad({ filter: /.*/, namespace: "v" }, (args) => {
                  loads.push({ namespace: args.namespace, loader: args.loader });
                  const contents =
                    loader === "js" || loader === "ts"
                      ? "export const x = 1;"
                      : loader === "json"
                        ? '{"a":1}'
                        : loader === "jsonc"
                          ? '{/*c*/"a":1,}'
                          : loader === "toml"
                            ? "a = 1\n"
                            : loader === "yaml"
                            ? "a: 1\n"
                            : loader === "xml"
                              ? "<r/>"
                              : loader === "css"
                                ? ".a{color:red}"
                                : loader === "html"
                                  ? "<p>hi</p>"
                                  : "content";
                  return { contents, loader };
                });
              },
            },
          ],
        });
        expect({ loader, success: result.success }).toEqual({ loader, success: true });
      }
      expect(loads.length).toBe(loaders.length);
      for (const args of loads) {
        expect(args.namespace).toBe("v");
        expect(typeof args.loader).toBe("string");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("onResolve args and external are wider than the page type", async () => {
    // Page: args { path, importer }; return { path, namespace? } | void.
    // Measured: args also carry kind, namespace and resolveDir; returning
    // external: true keeps the import out of the bundle.
    const root = project();
    let argKeys: string[] = [];
    writeFileSync(
      join(root, "entry.ts"),
      'import "virt-ext";\nimport { x } from "virt-rs";\nconsole.log(x);\n',
    );
    try {
      const result = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        plugins: [
          {
            name: "resolve-shape",
            setup(build) {
              build.onResolve({ filter: /^virt-ext$/ }, () => ({
                path: "virt-ext",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...({ external: true } as any),
              }));
              build.onResolve({ filter: /^virt-rs$/ }, (args) => {
                argKeys = Object.keys(args).sort();
                return { path: "virt-rs", namespace: "v" };
              });
              build.onLoad({ filter: /.*/, namespace: "v" }, () => ({
                contents: "export const x = 1;",
                loader: "js",
              }));
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      for (const key of ["importer", "kind", "namespace", "path", "resolveDir"]) {
        expect(argKeys).toContain(key);
      }
      const js = await Bun.file(join(root, "out/entry.js")).text();
      expect(js).toContain('"virt-ext"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("binary contents are accepted and onBeforeParse exists", async () => {
    // Page: contents?: string and no onBeforeParse on PluginBuilder. Installed
    // types allow buffers and declare onBeforeParse; measured both hold.
    const root = project();
    writeFileSync(join(root, "entry.ts"), 'import { x } from "virt-bin";\nconsole.log(x);\n');
    let beforeParse = "absent";
    try {
      const result = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        plugins: [
          {
            name: "binary",
            setup(build) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              beforeParse = typeof (build as any).onBeforeParse;
              build.onResolve({ filter: /^virt-bin$/ }, () => ({
                path: "virt-bin",
                namespace: "v",
              }));
              build.onLoad({ filter: /.*/, namespace: "v" }, () => ({
                contents: new TextEncoder().encode("export const x = 3;"),
                loader: "js",
              }));
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(beforeParse).toBe("function");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("lifecycle order is start > resolve > load > end", async () => {
    const root = project();
    const order: string[] = [];
    writeFileSync(join(root, "entry.ts"), 'import { x } from "virt";\nconsole.log(x);\n');
    try {
      const result = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        plugins: [
          {
            name: "order",
            setup(build) {
              build.onStart(() => {
                order.push("start");
              });
              build.onResolve({ filter: /^virt$/ }, () => {
                order.push("resolve");
                return { path: "virt", namespace: "v" };
              });
              build.onLoad({ filter: /.*/, namespace: "v" }, () => {
                order.push("load");
                return { contents: "export const x = 1;", loader: "js" };
              });
              build.onEnd(() => {
                order.push("end");
              });
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(order).toEqual(["start", "resolve", "load", "end"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("onBeforeParse is native-only: a JS object is refused with a TypeError", async () => {
    // The docs describe onBeforeParse as zero-copy native addons in the parser
    // thread; installed types take { napiModule, symbol, external? }, not a
    // callback. Measured: registration throws a TypeError naming the requirement.
    const root = project();
    try {
      // Registration throws synchronously from setup, so a `.catch()` on the
      // promise would never see it; the try/catch must wrap the call itself.
      let error: Error | undefined;
      try {
        await Bun.build({
          entrypoints: [join(root, "entry.ts")],
          outdir: join(root, "out"),
          plugins: [
            {
              name: "before-parse",
              setup(build) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (build as any).onBeforeParse({ filter: /.*/ }, { napiModule: {}, symbol: "x" });
              },
            },
          ],
        });
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeInstanceOf(TypeError);
      const message = error?.message ?? "";
      expect(message).toContain("Napi module");
      expect(message).toContain("BUN_PLUGIN_NAME");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

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

  test("onLoad `exports` without loader:'object' is rejected", async () => {
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

  test("onLoad exports WITH loader:'object' is accepted and tree-shakes", async () => {
    const root = project();
    writeFileSync(
      join(root, "entry.ts"),
      'import { b } from "virtual";\nconsole.log(JSON.stringify(b));\n',
    );
    try {
      const result = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        plugins: [
          {
            name: "exports-object",
            setup(build) {
              // onLoad sees the resolved path, so a bare specifier needs a
              // namespace via onResolve before the object form can apply.
              build.onResolve({ filter: /^virtual$/ }, () => ({
                path: "virtual",
                namespace: "v",
              }));
              build.onLoad({ filter: /.*/, namespace: "v" }, () => ({
                exports: { a: 1, b: 2 },
                loader: "object",
              }));
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      const js = await Bun.file(join(root, "out/entry.js")).text();
      expect(js).toContain("b = 2");
      expect(js).not.toContain("a = 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
