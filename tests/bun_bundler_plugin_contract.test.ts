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

  test("exports wins only with loader:'object'; contents wins otherwise", async () => {
    const root = project();
    writeFileSync(join(root, "entry.ts"), "export const original = 0;\n");
    const build = (plugin: unknown) =>
      Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, `out-${Math.random().toString(36).slice(2)}`),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plugins: [plugin as any],
      });
    const loadWith = (ret: unknown) => ({
      name: "precedence",
      setup(build: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        build.onLoad({ filter: /entry\.ts$/ }, () => ret as any);
      },
    });
    try {
      // object loader: exports defines the module, contents ignored
      const objectBuild = await build(
        loadWith({ contents: "export const x = 1;", exports: { y: 2 }, loader: "object" }),
      );
      expect(objectBuild.success).toBe(true);
      const objectJs = await Bun.file(objectBuild.outputs[0]!.path).text();
      expect(objectJs).toContain("y = 2");
      expect(objectJs).not.toContain("x = 1");

      // js loader: contents wins, exports ignored
      const jsBuild = await build(
        loadWith({ contents: "export const x = 1;", exports: { y: 2 }, loader: "js" }),
      );
      expect(jsBuild.success).toBe(true);
      const jsOut = await Bun.file(jsBuild.outputs[0]!.path).text();
      expect(jsOut).toContain("x = 1");
      expect(jsOut).not.toContain("y = 2");

      // non-object loader without contents: exports alone is not enough
      let error: Error | undefined;
      try {
        await build(loadWith({ exports: { y: 2 }, loader: "js" }));
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeInstanceOf(Error);
      const details = [...((error as AggregateError).errors ?? [])]
        .map((e) => (e as Error).message)
        .join("; ");
      expect(details).toContain("contents");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("object exports tree-shakes named imports like the default toml loader", async () => {
    const root = project();
    writeFileSync(
      join(root, "slab.toml"),
      '[meta]\nschema = "v1"\n\n[unsafe]\nallowed = false\n\n[capacity]\nticker_window_bytes = 4096\n',
    );
    writeFileSync(join(root, "a.ts"), 'import { meta } from "./slab.toml";\nconsole.log(JSON.stringify(meta));\n');
    writeFileSync(join(root, "b.ts"), 'import { meta } from "virt";\nconsole.log(JSON.stringify(meta));\n');
    try {
      const a = await Bun.build({
        entrypoints: [join(root, "a.ts")],
        outdir: join(root, "out-a"),
        target: "bun",
      });
      const b = await Bun.build({
        entrypoints: [join(root, "b.ts")],
        outdir: join(root, "out-b"),
        target: "bun",
        plugins: [
          {
            name: "virt",
            setup(build) {
              build.onResolve({ filter: /^virt$/ }, () => ({ path: "virt", namespace: "v" }));
              build.onLoad({ filter: /.*/, namespace: "v" }, () => ({
                exports: {
                  meta: { schema: "v1" },
                  unsafe: { allowed: false },
                  capacity: { ticker_window_bytes: 4096 },
                },
                loader: "object",
              }));
            },
          },
        ],
      });
      expect(a.success && b.success).toBe(true);
      const A = await Bun.file(join(root, "out-a/a.js")).text();
      const B = await Bun.file(join(root, "out-b/b.js")).text();
      for (const js of [A, B]) {
        expect(js).toContain("v1");
        expect(js).not.toContain("allowed");
        expect(js).not.toContain("ticker_window_bytes");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("external keeps a virtual import, via config and via onResolve", async () => {
    const root = project();
    writeFileSync(join(root, "entry.ts"), 'import "virt-ext";\nconsole.log("x");\n');
    try {
      const viaConfig = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out-config"),
        external: ["virt-ext"],
      });
      expect(viaConfig.success).toBe(true);
      expect(await Bun.file(join(root, "out-config/entry.js")).text()).toContain("virt-ext");

      const viaResolve = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out-resolve"),
        plugins: [
          {
            name: "ext",
            setup(build) {
              build.onResolve({ filter: /^virt-ext$/ }, () => ({
                path: "virt-ext",
                external: true,
              }));
            },
          },
        ],
      });
      expect(viaResolve.success).toBe(true);
      expect(await Bun.file(join(root, "out-resolve/entry.js")).text()).toContain("virt-ext");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("setup may be async and is awaited before the build", async () => {
    const root = project();
    const marks: string[] = [];
    try {
      const started = performance.now();
      const result = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        plugins: [
          {
            name: "async-setup",
            async setup(build) {
              marks.push("setup-start");
              await Bun.sleep(40);
              marks.push("setup-end");
              build.onLoad({ filter: /entry\.ts$/ }, () => ({
                contents: "export const x = 99;",
                loader: "js",
              }));
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(marks).toEqual(["setup-start", "setup-end"]);
      expect(performance.now() - started).toBeGreaterThanOrEqual(30);
      const js = await Bun.file(join(root, "out/entry.js")).text();
      expect(js).toContain("x = 99");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("plugin target does not gate application under Bun.build on 1.4.4", async () => {
    // bun-types say target controls which builds apply the plugin ("bun" |
    // "browser" | "node", read by Bun.build); measured, it does not gate anything
    // here: a browser-targeted plugin applied to a bun build and a bun-targeted
    // plugin applied to a browser build. This test is a ratchet: if Bun starts
    // honoring target, the skipped case will fail and the expectation gets fixed.
    const root = project();
    writeFileSync(join(root, "entry.ts"), "export const answer = 42;\n");
    const plugin = (name: string, target: "bun" | "browser") => ({
      name,
      target,
      setup(build: {
        onLoad: (
          opts: { filter: RegExp },
          cb: () => { contents: string; loader: "js" },
        ) => void;
      }) {
        build.onLoad({ filter: /entry\.ts$/ }, () => ({
          contents: "export const answer = 43;",
          loader: "js" as const,
        }));
      },
    });
    try {
      for (const [buildTarget, pluginTarget] of [
        ["bun", "browser"],
        ["browser", "bun"],
      ] as const) {
        const result = await Bun.build({
          entrypoints: [join(root, "entry.ts")],
          outdir: join(root, `out-${buildTarget}-${pluginTarget}`),
          target: buildTarget,
          plugins: [plugin(`p-${pluginTarget}`, pluginTarget)],
        });
        expect({ buildTarget, pluginTarget, success: result.success }).toEqual({
          buildTarget,
          pluginTarget,
          success: true,
        });
        const js = await Bun.file(
          join(root, `out-${buildTarget}-${pluginTarget}/entry.js`),
        ).text();
        expect(js).toContain("answer = 43");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("plugin array order decides which plugin loads a module (first wins)", async () => {
    // Two plugins with the same onLoad filter: the earlier entry in `plugins`
    // supplies the module and the later one never runs. Duplicate names are
    // allowed and behave the same way; an empty array is a no-op.
    const root = project();
    writeFileSync(join(root, "entry.ts"), "export const answer = 42;\n");
    const plugin = (name: string, value: number) => ({
      name,
      setup(build: {
        onLoad: (
          opts: { filter: RegExp },
          cb: () => { contents: string; loader: "js" },
        ) => void;
      }) {
        build.onLoad({ filter: /entry\.ts$/ }, () => ({
          contents: `export const answer = ${value};`,
          loader: "js" as const,
        }));
      },
    });
    const buildWith = async (label: string, plugins: ReturnType<typeof plugin>[]) => {
      const result = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        outdir: join(root, `out-${label}`),
        plugins,
      });
      expect(result.success).toBe(true);
      const js = await Bun.file(join(root, `out-${label}/entry.js`)).text();
      const match = js.match(/answer = (\d+)/);
      return match?.[1];
    };
    try {
      expect(await buildWith("a-then-b", [plugin("a", 100), plugin("b", 200)])).toBe("100");
      expect(await buildWith("b-then-a", [plugin("b", 200), plugin("a", 100)])).toBe("200");
      expect(await buildWith("dupes", [plugin("same", 1), plugin("same", 2)])).toBe("1");
      expect(await buildWith("empty", [])).toBe("42");
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
