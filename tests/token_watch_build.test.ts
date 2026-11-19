import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTokenWatch,
  TOKEN_WATCH_LOCKDOWN_ARGV,
  tokenWatchBuildArgs,
} from "../scripts/build_token_watch.ts";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = "scripts/build_token_watch.ts";

/** The runtime flag the baked `--compile-exec-argv` must make permanent. */
const RUNTIME_LOCKDOWN = "--disallow-code-generation-from-strings=strict";
const LOCKDOWN = `--compile-exec-argv=${RUNTIME_LOCKDOWN}`;

/**
 * Probe fixture: succeeds only when string code generation is allowed. A hardened build must
 * print `{"error":"EvalError"}`; an unhardened build prints the computed `{"eval":42}`.
 */
const FIXTURE = `try {
  console.log(JSON.stringify({ eval: new Function("return 6*7")() }));
} catch (e) {
  console.log(JSON.stringify({ error: (e as Error)?.name }));
}
`;

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "token-watch-build-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runBinary(
  binary: string,
  args: readonly string[] = [],
): { readonly exitCode: number | null; readonly stdout: string } {
  const proc = Bun.spawnSync([binary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
  };
}

function runCli(args: readonly string[]): {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const proc = Bun.spawnSync([process.execPath, "run", SCRIPT, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("tokenWatchBuildArgs", () => {
  test("bakes the string-codegen lockdown in the documented order", () => {
    const entrypoint = join(tmpdir(), "token-watch-entry.ts");
    const outfile = join(tmpdir(), "token-watch");
    expect(TOKEN_WATCH_LOCKDOWN_ARGV).toEqual([LOCKDOWN]);

    const argv = tokenWatchBuildArgs({ entrypoint, outfile });
    expect(argv).toEqual([
      "build",
      entrypoint,
      "--compile",
      LOCKDOWN,
      "--outfile",
      outfile,
    ]);
    // `bun build` takes the entrypoint as its positional argument, directly after `build`.
    expect(argv[0]).toBe("build");
    expect(argv[1]).toBe(entrypoint);
    // `--outfile <path>` is the final pair; every token after the entry is a bun build flag.
    expect(argv.slice(-2)).toEqual(["--outfile", outfile]);
    expect(argv.indexOf(LOCKDOWN)).toBeLessThan(argv.length - 2);
    expect(argv.filter((token) => token === entrypoint)).toHaveLength(1);
  });

  test("extraArgs stay between the baked lockdown argument and --outfile", () => {
    const argv = tokenWatchBuildArgs({
      entrypoint: "scripts/token_watch_entry.ts",
      outfile: "dist/token-watch",
      extraArgs: ["--minify", "--sourcemap=external"],
    });
    expect(argv).toEqual([
      "build",
      "scripts/token_watch_entry.ts",
      "--compile",
      LOCKDOWN,
      "--minify",
      "--sourcemap=external",
      "--outfile",
      "dist/token-watch",
    ]);
  });
});

describe("buildTokenWatch failure path", () => {
  test("reports the exit code and stderr from a failed build", () => {
    const options = {
      entrypoint: "/nonexistent/token_watch_entry.ts",
      outfile: join(tmpdir(), "token-watch-unused"),
    };
    const seen: (readonly string[])[] = [];
    const result = buildTokenWatch(options, (argv) => {
      seen.push(argv);
      return { exitCode: 1, stderr: "error: Module not found" };
    });

    expect(result).toEqual({
      ok: false,
      exitCode: 1,
      stderr: "error: Module not found",
    });
    // The injected runner must receive exactly the hardened argv, not a variant.
    expect(seen).toEqual([tokenWatchBuildArgs(options)]);
  });
});

describe("compiled token-watch binary", () => {
  test("the baked --compile-exec-argv lockdown makes new Function throw EvalError", () => {
    const dir = tempDir();
    const entrypoint = join(dir, "main.ts");
    const outfile = join(dir, "token-watch-locked");
    writeFileSync(entrypoint, FIXTURE, "utf8");

    const build = buildTokenWatch({ entrypoint, outfile });
    if (!build.ok) {
      throw new Error(`build failed (exit ${build.exitCode}): ${build.stderr}`);
    }
    expect(existsSync(outfile)).toBe(true);

    const run = runBinary(outfile);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ error: "EvalError" });
  }, 30_000);
  // The unhardened control binary (plain `--compile`, which prints {"eval":42} even with the
  // runtime flag — measured on the pin, 2026-11-18) is deliberately not built or executed here:
  // a cold compiled-binary exec costs ~1.5 s and the control only re-proves the premise recorded
  // in scripts/build_token_watch.ts, while the test above is the contract that matters.
});

describe("CLI", () => {
  test("exits nonzero with usage when --entry/--out are missing", () => {
    const proc = runCli([]);
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("usage:");
    expect(proc.stderr).toContain("--entry");
    expect(proc.stderr).toContain("--out");
  });

  test("builds a hardened binary from --entry/--out", () => {
    const dir = tempDir();
    const entrypoint = join(dir, "main.ts");
    const outfile = join(dir, "token-watch-cli");
    writeFileSync(entrypoint, FIXTURE, "utf8");

    const proc = runCli(["--entry", entrypoint, "--out", outfile]);
    expect(proc.stderr).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(existsSync(outfile)).toBe(true);
    expect(proc.stdout.trim()).toBe(outfile);
    // Hardening is proven above through the shared buildTokenWatch path; executing the
    // CLI-built binary again would add another ~1.5 s cold exec for no new coverage.
  }, 30_000);

  test("exits nonzero with a clear message when the build fails", () => {
    const dir = tempDir();
    const proc = runCli([
      "--entry",
      join(dir, "missing.ts"),
      "--out",
      join(dir, "token-watch-missing"),
    ]);
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("token-watch build failed");
  }, 30_000);
});
