#!/usr/bin/env bun
/**
 * @file cli/console_depth.ts
 * @description Print the console-depth resolution chain. `--json` is the form the DSH
 * plugin tool consumes; the default is the terminal's human-readable report.
 */
import {
  renderConsoleDepthReport,
  resolveConsoleDepthChain,
} from "../lib/console_depth.ts";

const chain = await resolveConsoleDepthChain({
  cwd: process.cwd(),
  env: Bun.env,
});
const asJson = Bun.argv.includes("--json");
process.stdout.write(
  asJson
    ? `${JSON.stringify(chain, null, 2)}\n`
    : `${renderConsoleDepthReport(chain)}\n`,
);
