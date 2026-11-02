import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { configFormat, parseConfig, readConfig } from "../lib/config_file.ts";
import { UsageError } from "../lib/usage_error.ts";

describe("configFormat", () => {
  test("yaml and the JSON family, case-insensitive", () => {
    expect(configFormat("desk.yaml")).toBe("yaml");
    expect(configFormat("conf/DESK.YML")).toBe("yaml");
    expect(configFormat("desk.json")).toBe("json5");
    expect(configFormat("desk.jsonc")).toBe("json5");
    expect(configFormat("desk.JSON5")).toBe("json5");
    expect(configFormat(".yaml")).toBe("yaml");
    expect(configFormat("dir/.desk.yml")).toBe("yaml");
  });

  test("no extension, a dotted directory or an unknown extension is a usage error, not JSON5", () => {
    for (const [path, shown] of [
      ["config", "(none)"],
      ["conf.d/settings", "(none)"],
      ["desk.toml", '".toml"'],
      ["desk.yaml.bak", '".bak"'],
    ] as const) {
      expect(() => configFormat(path)).toThrow(UsageError);
      expect(() => configFormat(path)).toThrow(
        `${path}: unsupported config extension ${shown}`,
      );
    }
  });
});

describe("parseConfig", () => {
  test("JSON5 takes comments and trailing commas; YAML takes block style", () => {
    expect(parseConfig("{a: 1, // note\n b: [1, 2,],}", "json5")).toEqual({
      a: 1,
      b: [1, 2],
    });
    expect(parseConfig("a: 1\nb:\n  - 2\n", "yaml")).toEqual({ a: 1, b: [2] });
  });

  test("a syntax error becomes a UsageError led by the source, with the parser error as cause", () => {
    let caught: unknown;
    try {
      parseConfig("a: [1", "yaml", "desk.yaml");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).message).toBe(
      "desk.yaml: YAML Parse error: Unexpected token",
    );
    expect((caught as UsageError).cause).toBeInstanceOf(SyntaxError);
    expect(() => parseConfig("{a:", "json5")).toThrow(
      "config: JSON5 Parse error:",
    );
  });

  test("a multi-document YAML stream comes back as an array", () => {
    expect(parseConfig("a: 1\n---\nb: 2\n", "yaml")).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });
});

describe("readConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "config-file-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const Desk = z.object({
    name: z.string(),
    timeoutMs: z.number().int().positive(),
    enabled: z.boolean(),
  });

  test("reads, parses and validates; YAML and JSON5 give the same value", async () => {
    const yaml = join(dir, "desk.yaml");
    const json5 = join(dir, "desk.json5");
    await Bun.write(yaml, "name: desk\ntimeoutMs: 20000\nenabled: true\n");
    await Bun.write(json5, "{name: 'desk', timeoutMs: 20000, enabled: true,}");
    const expected = { name: "desk", timeoutMs: 20_000, enabled: true };
    expect(await readConfig(yaml, Desk)).toEqual(expected);
    expect(await readConfig(json5, Desk)).toEqual(expected);
  });

  test("schema failures name the file and every bad field", async () => {
    const path = join(dir, "bad.yml");
    await Bun.write(path, "name: desk\ntimeoutMs: -1\nenabled: yes\n");
    const failure = readConfig(path, Desk);
    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toThrow(`${path}: timeoutMs: `);
    await expect(failure).rejects.toThrow("; enabled: ");
  });

  test("a missing file is a usage error naming it", async () => {
    const path = join(dir, "missing.yaml");
    await expect(readConfig(path, Desk)).rejects.toThrow(
      `${path}: no such file`,
    );
  });
});
