/**
 * @file tests/bun_globals_contract.test.ts
 * @description Pins the documented-vs-actual Bun globals classification.
 *
 * These assertions are the evidence behind `lib/bun_globals_contract.ts`: if a
 * future Bun adds, removes, or documents one of these globals, the classification
 * changes here rather than silently drifting.
 */
import { describe, expect, test } from "bun:test";
import {
  DOCUMENTED_GLOBALS,
  MODULE_SCOPED_GLOBALS,
  UNDOCUMENTED_WEB_SURFACE,
  globalsContract,
} from "../lib/bun_globals_contract.ts";

describe("globalsContract", () => {
  const report = globalsContract();

  test("every non-module-scoped documented global is really on globalThis", () => {
    expect(report.documentedAbsent).toEqual([]);
    expect(report.documentedPresent).not.toContain("require");
  });

  test("the CommonJS names are module-scoped, not global properties", () => {
    expect([...report.moduleScopedOnly].sort()).toEqual(
      [...MODULE_SCOPED_GLOBALS].sort(),
    );
    for (const name of MODULE_SCOPED_GLOBALS) {
      expect(name in globalThis).toBe(false);
    }
  });

  test("URLPattern and Temporal are present even though the table omits them", () => {
    expect(report.undocumentedWeb).toEqual(
      expect.arrayContaining(["URLPattern", "Temporal", "WebSocket"]),
    );
    // The global must stay callable; the validator imports the same constructor
    // from `node:url` so it works even where the global is absent.
    expect(typeof URLPattern).toBe("function");
    expect(typeof Temporal).toBe("object");
  });

  test("Node globals are present; Node module names are not", () => {
    for (const name of ["Buffer", "process", "global"]) {
      expect(name in globalThis).toBe(true);
    }
    // `bun -e` exposes `fs`, `path`, ... as globals; `bun test` does not.
    for (const name of ["fs", "path", "os", "http"]) {
      expect(name in globalThis).toBe(false);
    }
  });

  test("the recorded undocumented surface is still all present", () => {
    for (const name of UNDOCUMENTED_WEB_SURFACE) {
      expect(name in globalThis).toBe(true);
    }
  });

  test("is a pure function of the supplied scope", () => {
    const empty = globalsContract({});
    const documentedNonModule =
      DOCUMENTED_GLOBALS.length - MODULE_SCOPED_GLOBALS.length;
    expect(empty.documentedPresent).toEqual([]);
    expect(empty.documentedAbsent).toHaveLength(documentedNonModule);
    expect(empty.moduleScopedOnly).toHaveLength(MODULE_SCOPED_GLOBALS.length);
    expect(empty.undocumentedWeb).toEqual([]);
  });

  test("is deterministic", () => {
    expect(globalsContract()).toEqual(report);
  });

  test("module-scope names still resolve as identifiers", () => {
    const script = `
      process.stdout.write(JSON.stringify({
        require: typeof require,
        module: typeof module,
        exports: typeof exports,
        dirname: typeof __dirname,
        filename: typeof __filename,
      }));
    `;
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual({
      require: "function",
      module: "object",
      exports: "object",
      dirname: "string",
      filename: "string",
    });
  });
});
