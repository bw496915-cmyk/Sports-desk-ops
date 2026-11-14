/**
 * @file scripts/build_plugins/slab_config_guard.ts
 * @description Build-time guard for the frontend slab TOML config.
 *
 * The browser bundle must never inherit `unsafe.allowed = true` from the server
 * slab policy. `packages/ui/src/config/slab.ts` also throws at module load, but
 * that is a runtime failure in the browser; this plugin moves the same assertion
 * to the build.
 *
 * Bun 1.4.4 does NOT support returning `exports` from `onLoad` (measured
 * 2026-11-14: "onLoad plugins must return an object with \"contents\" as a string
 * or Uint8Array"), so the plugin parses and validates, then returns the original
 * text with the default `toml` loader — behaviour, tree-shaking and inlining stay
 * identical to the default loader (measured: importing only one top-level export
 * drops the others).
 */
import type { BunPlugin } from "bun";

const FRONTEND_CONFIG = /packages\/ui\/src\/config\/[^/]+\.toml$/;

export const slabConfigGuard: BunPlugin = {
  name: "slab-config-guard",
  setup(build) {
    build.onLoad({ filter: FRONTEND_CONFIG }, async ({ path }) => {
      const text = await Bun.file(path).text();
      const config = Bun.TOML.parse(text) as Record<string, unknown>;
      const unsafe = config["unsafe"];
      if (unsafe !== undefined) {
        if (
          typeof unsafe !== "object" ||
          unsafe === null ||
          (unsafe as Record<string, unknown>)["allowed"] !== false
        ) {
          const name = path.split("/").pop() ?? path;
          throw new Error(
            `slab-config-guard: ${name} must set unsafe.allowed = false for the frontend bundle (found ${JSON.stringify((unsafe as Record<string, unknown>)?.["allowed"])})`,
          );
        }
      }
      return { contents: text, loader: "toml" };
    });
  },
};
