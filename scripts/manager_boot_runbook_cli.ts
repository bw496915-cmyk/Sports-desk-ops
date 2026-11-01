#!/usr/bin/env bun
/**
 * Render manager-boot evidence runbook to the terminal (Bun.markdown.render hooks).
 *
 *   bun run manager-boot:runbook
 *   bun run manager-boot:runbook -- --no-appendix --plain
 *   bun run manager-boot:runbook -- --html > /tmp/runbook.html
 */
import { parseArgs } from "node:util";

import {
  loadManagerBootRunbookMarkdown,
  printManagerBootRunbook,
  renderManagerBootRunbookTerminal,
} from "../lib/manager_boot_runbook_render.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    file: { type: "string" },
    html: { type: "boolean" },
    plain: { type: "boolean" },
    "no-appendix": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`manager-boot:runbook — ANSI runbook via Bun.markdown.render

Options:
  --file <path>     Markdown source (default: docs/evidence/manager-boot-hierarchy.md)
  --no-appendix     Omit operator loop (login / probe / ingest / gates)
  --plain           No ANSI color (NO_COLOR semantics)
  --html            Write Bun.markdown.html to stdout (not sanitized — do not pipe to browser untrusted)
  -h, --help
`);
  process.exit(0);
}

const markdown = await loadManagerBootRunbookMarkdown({
  docPath: values.file?.trim(),
  includeOperatorAppendix: values["no-appendix"] !== true,
});

if (values.html) {
  process.stdout.write(`${Bun.markdown.html(markdown)}\n`);
  process.exit(0);
}

printManagerBootRunbook(markdown, {
  colors: values.plain !== true,
  includeOperatorAppendix: values["no-appendix"] !== true,
});
