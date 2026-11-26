#!/usr/bin/env bun
/**
 * @file scripts/lint_native.ts
 * @description Resolve and invoke a native `bun lint` binary (`Bun canary` or `1.5+`),
 * falling back cleanly with exit 2 when only stable `1.4.5` is installed.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type BunReleaseChannel,
  detectBunReleaseChannel,
} from "@sportsdesk-ops/contracts/bun-release-channel";

export type BunLintProbe = "native" | "not-native" | "missing";

export interface BunLintCandidateReport {
  readonly bin: string;
  readonly probe: BunLintProbe;
}

/** Classify one candidate without assuming it is an absolute path. */
export function probeBunLintBin(bin: string, probeDir = "/tmp"): BunLintProbe {
  try {
    const res = Bun.spawnSync([bin, "lint", "--help"], {
      cwd: probeDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) return "not-native";
    const out = `${new TextDecoder().decode(res.stdout)}${new TextDecoder().decode(res.stderr)}`;
    return out.includes("Usage: bun lint") ? "native" : "not-native";
  } catch {
    return existsSync(bin) ? "not-native" : "missing";
  }
}

export function hasNativeBunLint(bin: string, probeDir = "/tmp"): boolean {
  return probeBunLintBin(bin, probeDir) === "native";
}

export function probeBunLintCandidates(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): BunLintCandidateReport[] {
  return candidateBunLintBins(env).map((bin) => ({
    bin,
    probe: probeBunLintBin(bin),
  }));
}

/** Human-readable diagnostics; no writes and no network. */
export function formatBunLintDoctor(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  const reports = probeBunLintCandidates(env);
  const native =
    reports.find((report) => report.probe === "native")?.bin ?? null;
  const lines = [
    `Bun ${Bun.version} (${process.platform}/${process.arch})`,
    `native lint: ${native === null ? "unavailable" : "available"}`,
    `resolved: ${native ?? "(none)"}`,
    `BUN_LINT_BIN: ${env.BUN_LINT_BIN?.trim() || "(unset)"}`,
    `BUN_INSTALL: ${env.BUN_INSTALL?.trim() || "(unset)"}`,
    `HOME: ${env.HOME?.trim() || "(unset)"}`,
    "candidates:",
    ...reports.map((report) => `  [${report.probe}] ${report.bin}`),
  ];
  if (native === null) {
    lines.push(
      "provision: install a canary build under $HOME/.bun-canary, put `bun-canary` on PATH,",
      "           set BUN_INSTALL to an isolated canary install, or set BUN_LINT_BIN.",
    );
  }
  return lines.join("\n");
}

export function bunLintDoctorJson(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): {
  readonly bun: string;
  readonly channel: BunReleaseChannel;
  readonly native: boolean;
  readonly resolved: string | null;
  readonly candidates: readonly BunLintCandidateReport[];
} {
  const candidates = probeBunLintCandidates(env);
  const resolved =
    candidates.find((candidate) => candidate.probe === "native")?.bin ?? null;
  return {
    bun: Bun.version,
    channel: detectBunReleaseChannel(Bun.version),
    native: resolved !== null,
    resolved,
    candidates,
  };
}

function pushCanaryEntries(candidates: string[], binDir: string): void {
  if (!existsSync(binDir)) return;
  try {
    const entries = readdirSync(binDir)
      .filter((name) => name.startsWith("bun-canary"))
      .sort()
      .reverse();
    for (const entry of entries) candidates.push(join(binDir, entry));
  } catch {
    // Ignore unreadable bin dirs in restricted environments
  }
}

export function candidateBunLintBins(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string[] {
  const candidates: string[] = [];
  const explicit = env.BUN_LINT_BIN?.trim();
  if (explicit) candidates.push(explicit);

  candidates.push(process.execPath);

  const whichCanary = Bun.which("bun-canary", { PATH: env.PATH ?? "" });
  if (whichCanary) candidates.push(whichCanary);

  const install = env.BUN_INSTALL?.trim();
  if (install) {
    // `BUN_INSTALL=... bun upgrade --canary` writes `<install>/bin/bun`.
    candidates.push(join(install, "bin", "bun"));
    pushCanaryEntries(candidates, join(install, "bin"));
  }

  const home = env.HOME?.trim();
  if (home) {
    // Isolated official installer: BUN_INSTALL="$HOME/.bun-canary" ... | bash
    candidates.push(join(home, ".bun-canary", "bin", "bun"));
    pushCanaryEntries(candidates, join(home, ".bun-canary", "bin"));
    pushCanaryEntries(candidates, join(home, ".bun", "bin"));
  }

  return [...new Set(candidates)];
}

export function resolveNativeBunLintBin(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string | null {
  for (const bin of candidateBunLintBins(env)) {
    if (hasNativeBunLint(bin)) return bin;
  }
  return null;
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const doctor = argv.find(
    (arg) => arg === "--doctor" || arg.startsWith("--doctor="),
  );
  if (doctor !== undefined) {
    if (doctor === "--doctor=json" || argv.includes("--json")) {
      console.log(JSON.stringify(bunLintDoctorJson(), null, 2));
    } else {
      console.log(formatBunLintDoctor());
    }
    process.exit(0);
  }
  if (argv.includes("--print-resolved")) {
    const resolved = resolveNativeBunLintBin();
    if (resolved === null) {
      console.error("(none)");
      process.exit(2);
    }
    console.log(resolved);
    process.exit(0);
  }

  const bin = resolveNativeBunLintBin();
  if (bin === null) {
    console.error(
      `lint:native unavailable on Bun ${Bun.version} (no native \`bun lint\` binary found; requires a Bun canary build or BUN_LINT_BIN).`,
    );
    process.exit(2);
  }

  const child = Bun.spawnSync([bin, "lint", "--no-script", ...argv], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(child.exitCode);
}
