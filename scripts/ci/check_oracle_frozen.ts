#!/usr/bin/env bun
/**
 * @file scripts/ci/check_oracle_frozen.ts
 * @description Contract-freeze gate: a schema change must be paired with an oracle change.
 *
 * The oracle is the frozen specification. If the committed snapshot or the Code Mode argument
 * schema changes without `tests/code_mode/oracle.ts` changing, the suite would silently follow the
 * new contract instead of failing — so this gate fails first.
 *
 * Contract inputs (this repo's equivalent of `schema.ts`):
 *   - data/profile-snapshot.json      the 31-profile data contract
 *   - lib/profile_query_codemode.ts   the Code Mode argument schema (Zod)
 *
 *   bun run check:oracle-frozen
 *   ORACLE_BASE_REF=origin/main bun run check:oracle-frozen
 */

import { spawnSync } from "node:child_process";

const ORACLE = "tests/code_mode/oracle.ts";
const CONTRACT_INPUTS = [
  "data/profile-snapshot.json",
  "lib/profile_query_codemode.ts",
] as const;

const git = (args: readonly string[]): { ok: boolean; stdout: string } => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout.trim() };
};

const baseRef =
  process.env.ORACLE_BASE_REF ??
  (process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : "origin/main");

const baseExists =
  baseRef !== "" && git(["rev-parse", "--verify", "--quiet", baseRef]).ok;
const committed = baseExists ? [`${baseRef}...HEAD`] : ["HEAD"];
const diff = git(["diff", "--name-only", ...committed]);
if (!diff.ok) {
  console.error(
    `check:oracle-frozen: cannot diff against ${committed.join(" ")}`,
  );
  process.exit(2);
}
// Include uncommitted changes so a local pre-commit run sees the same pairing the CI push does.
const working = git(["diff", "--name-only", "HEAD"]);
if (!working.ok) {
  console.error(
    "check:oracle-frozen: cannot diff the working tree against HEAD",
  );
  process.exit(2);
}

const changed = new Set(
  [diff.stdout, working.stdout]
    .flatMap((output) => (output === "" ? [] : output.split("\n")))
    .filter((path) => path !== ""),
);
const contractChanges = CONTRACT_INPUTS.filter((path) => changed.has(path));
const oracleChanged = changed.has(ORACLE);

if (contractChanges.length > 0 && !oracleChanged) {
  console.error(
    "check:oracle-frozen: contract input changed without re-freezing the oracle",
  );
  for (const path of contractChanges) console.error(`  changed: ${path}`);
  console.error(`  missing: ${ORACLE}`);
  console.error(
    `Re-freeze deliberately: update ${ORACLE} (counts, sentinel ids, field map) in the same change.`,
  );
  process.exit(1);
}

const comparison = baseExists ? `${baseRef}...HEAD` : "HEAD (working tree)";
console.log(
  `check:oracle-frozen: ok — ${contractChanges.length} contract change(s) against ${comparison}, oracle ${oracleChanged ? "updated" : "unchanged"}`,
);
