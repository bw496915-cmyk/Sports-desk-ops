#!/usr/bin/env bun
/**
 * @file scripts/render_tasks.ts
 * @description Render `docs/REMAINING_TASKS.md` with Bun's native GFM parser.
 *
 * Usage:
 *   bun run scripts/render_tasks.ts [--out scratch/remaining-tasks.html]
 *
 * Bun.markdown enables GFM tables, task lists and strikethrough by default; the options are passed
 * explicitly so a future default change cannot silently drop checkboxes.
 */

const GFM = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
} as const;

function flag(
  args: readonly string[],
  names: readonly string[],
  fallback: string,
): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1]!;
  }
  return fallback;
}

const args = process.argv.slice(2);
const source = flag(args, ["--source"], "docs/REMAINING_TASKS.md");
const out = flag(args, ["--out"], "scratch/remaining-tasks.html");

const markdown = await Bun.file(source).text();
const html = Bun.markdown.html(markdown, GFM);
await Bun.write(out, html);

const unchecked = (markdown.match(/^- \[ \]/gm) ?? []).length;
const checked = (markdown.match(/^- \[x\]/gm) ?? []).length;
const checkboxes = (html.match(/type="checkbox"/g) ?? []).length;

console.log(`tasks: ${unchecked} open, ${checked} done`);
console.log(`render: ${checkboxes} checkboxes, ${html.length} bytes -> ${out}`);
if (checkboxes !== unchecked + checked) {
  console.error("checkboxes do not match markdown task count");
  process.exitCode = 1;
}
