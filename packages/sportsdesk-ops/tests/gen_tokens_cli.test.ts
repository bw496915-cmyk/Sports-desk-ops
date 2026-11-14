import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GEN_TOKENS_DRIFT_EXIT_CODE, generate } from "../src/cli/gen-tokens.ts";

const cli = resolve(import.meta.dir, "../src/cli/gen-tokens.ts");
const tokensPath = resolve(import.meta.dir, "../../../design/tokens.toml");
const outDir = mkdtempSync(join(tmpdir(), "gen-tokens-"));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function run(...args: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

describe("gen-tokens CLI", () => {
  test("output is byte-identical across runs", async () => {
    const first = await generate(tokensPath);
    const second = await generate(tokensPath);
    expect(second).toEqual(first);
  });

  test("committed generated files have no drift", () => {
    expect(run("--check").exitCode).toBe(0);
  });

  test("--check exits 70 on a missing or edited output and 0 after regeneration", async () => {
    expect(GEN_TOKENS_DRIFT_EXIT_CODE).toBe(70);
    expect(run("--check", "--out-dir", outDir).exitCode).toBe(70);
    expect(run("--out-dir", outDir).exitCode).toBe(0);
    expect(run("--check", "--out-dir", outDir).exitCode).toBe(0);
    const css = join(outDir, "tokens.css");
    await Bun.write(css, `${await Bun.file(css).text()}/* edit */\n`);
    const drift = run("--check", "--out-dir", outDir);
    expect(drift.exitCode).toBe(70);
    expect(drift.output).toContain("ERR_GEN_TOKENS_DRIFT: tokens.css");
  });

  test("--a11y-report writes the perceptual audit and a failing palette blocks generation", async () => {
    const reportPath = join(outDir, "a11y-report.json");
    expect(run("--check", "--a11y-report", reportPath).exitCode).toBe(0);
    const report = (await Bun.file(reportPath).json()) as {
      schema: string;
      violations: unknown[];
      contrast: unknown[];
    };
    expect(report.schema).toBe("1.3.0");
    expect(report.violations).toEqual([]);
    expect(report.contrast.length).toBeGreaterThan(0);

    const weakTokens = join(outDir, "weak-tokens.toml");
    const original = await Bun.file(tokensPath).text();
    expect(original).toContain('"#7b8aa1"');
    await Bun.write(weakTokens, original.replaceAll('"#7b8aa1"', '"#334155"'));
    const blocked = run("--check", "--tokens", weakTokens, "--out-dir", outDir);
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.output).toContain("ERR_A11Y_");
  });

  test("unknown flags fail loudly", () => {
    const result = run("--bogus");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("ERR_GEN_TOKENS_USAGE");
  });
});
