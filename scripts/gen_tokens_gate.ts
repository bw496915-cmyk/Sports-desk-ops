#!/usr/bin/env bun
/**
 * Zero-drift gate driven by GEN_TOKEN_EMISSION_TARGETS (explicit phases).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  GEN_TOKEN_EMISSION_MANIFEST,
  GEN_TOKEN_EMISSION_TARGETS,
  type GenTokenEmissionManifest,
} from "../lib/gen_tokens/emission_targets.ts";

const rootDir = path.resolve(import.meta.dir, "..");

function git(args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf-8",
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

function run(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, {
    cwd: rootDir,
    stdio: "inherit",
    encoding: "utf-8",
  });
  return r.status ?? 1;
}

function pathsForReset(kind: "git-checkout-head" | "rm-before-gen"): string[] {
  return GEN_TOKEN_EMISSION_TARGETS.filter((t) => t.reset === kind).map(
    (t) => t.repoPath,
  );
}

function loadManifest(): GenTokenEmissionManifest | null {
  const manifestPath = path.join(rootDir, GEN_TOKEN_EMISSION_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(manifestPath, "utf-8"),
    ) as GenTokenEmissionManifest;
  } catch {
    return null;
  }
}

function main(): number {
  const allPaths = GEN_TOKEN_EMISSION_TARGETS.map((t) => t.repoPath);

  if (!git(["diff", "--quiet", "--", ...allPaths]).ok) {
    console.error(
      "::error::generated token outputs are dirty — commit or stash before running gen:tokens:gate",
    );
    spawnSync("git", ["diff", "--stat", "--", ...allPaths], {
      cwd: rootDir,
      stdio: "inherit",
    });
    return 1;
  }

  const manifestPath = path.join(rootDir, GEN_TOKEN_EMISSION_MANIFEST);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

  const checkoutPaths = pathsForReset("git-checkout-head");
  if (checkoutPaths.length > 0) {
    if (run("git", ["checkout", "HEAD", "--", ...checkoutPaths]) !== 0) {
      return 1;
    }
  }

  const rmPaths = pathsForReset("rm-before-gen");
  for (const p of rmPaths) {
    fs.rmSync(path.join(rootDir, p), { force: true });
  }

  if (run("bun", ["run", "gen:tokens"]) !== 0) {
    console.error(
      "::error::gen:tokens exited non-zero — fix scripts/generate_tokens.ts or tokens.toml (drift check skipped)",
    );
    return 1;
  }

  const manifest = loadManifest();
  const emitted = new Set(manifest?.emitted ?? []);

  let failed = 0;
  for (const target of GEN_TOKEN_EMISSION_TARGETS) {
    const full = path.join(rootDir, target.repoPath);
    if (!fs.existsSync(full)) {
      console.error(`::error::gen:tokens did not write ${target.repoPath}`);
      failed = 1;
      continue;
    }
    if (!emitted.has(target.repoPath)) {
      console.error(
        `::error::gen:tokens did not record emission for ${target.repoPath} (manifest miss — partial run or skip)`,
      );
      failed = 1;
      continue;
    }
    if (!git(["diff", "--quiet", "--", target.repoPath]).ok) {
      console.error(
        `::error::${target.repoPath} does not match gen:tokens output — run \`bun run gen:tokens\` and commit (do not hand-edit generated files)`,
      );
      spawnSync("git", ["diff", "--", target.repoPath], {
        cwd: rootDir,
        stdio: "inherit",
      });
      failed = 1;
    }
  }

  return failed;
}

process.exit(main());
