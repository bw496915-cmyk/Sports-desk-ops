#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GateRuleError,
  repoViewFromDirectory,
  repoViewFromGit,
  runRules,
  type GateFinding,
} from "./bun_native_rules.ts";

export const GATE_FAILURE_EXIT_CODE = 1;

export class VerifyCiGatesError extends Error {
  override readonly name = "VerifyCiGatesError";
  readonly code = "ERR_VERIFY_CI_GATES_USAGE" as const;
}

type Options = { root: string; json: boolean };

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    root: resolve(import.meta.dir, ".."),
    json: false,
  };
  for (let argIndex = 0; argIndex < argv.length; argIndex += 1) {
    const arg = argv[argIndex];
    if (arg === "--json") options.json = true;
    else if (arg === "--root") {
      const value = argv[argIndex + 1];
      if (value === undefined)
        throw new VerifyCiGatesError("--root needs a directory");
      options.root = resolve(value);
      argIndex += 1;
    } else throw new VerifyCiGatesError(`unknown argument ${arg}`);
  }
  return options;
}

function format(finding: GateFinding): string {
  const where =
    finding.file === undefined
      ? ""
      : ` ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`;
  return `  ${finding.severity.toUpperCase().padEnd(6)} ${finding.code}${where} — ${finding.detail}`;
}

export async function verifyCiGates(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const view = existsSync(join(options.root, ".git"))
    ? repoViewFromGit(options.root)
    : repoViewFromDirectory(options.root);
  const findings = await runRules(view, { bunVersion: Bun.version });
  const errors = findings.filter((finding) => finding.severity === "error");
  if (options.json) {
    console.log(
      JSON.stringify(
        { root: options.root, files: view.files.length, findings },
        null,
        2,
      ),
    );
  } else {
    const byRule = Map.groupBy(findings, (finding) => finding.rule);
    for (const [rule, ruleFindings] of byRule) {
      console.log(`[${rule}]`);
      for (const finding of ruleFindings) console.log(format(finding));
    }
    const waived = findings.filter(
      (finding) => finding.severity === "waived",
    ).length;
    const notices = findings.filter(
      (finding) => finding.severity === "notice",
    ).length;
    console.log(
      `verify_ci_gates: ${errors.length === 0 ? "PASS" : "FAIL"} — ${errors.length} error(s), ${waived} waived, ${notices} notice(s) across ${view.files.length} files (Bun ${Bun.version})`,
    );
  }
  return errors.length === 0 ? 0 : GATE_FAILURE_EXIT_CODE;
}

if (import.meta.main) {
  try {
    process.exitCode = await verifyCiGates(Bun.argv.slice(2));
  } catch (caught) {
    if (
      caught instanceof GateRuleError ||
      caught instanceof VerifyCiGatesError
    ) {
      console.error(`verify_ci_gates: ${caught.message}`);
      process.exitCode = 2;
    } else throw caught;
  }
}
