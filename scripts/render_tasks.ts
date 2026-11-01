#!/usr/bin/env bun
/**
 * @file scripts/render_tasks.ts
 * @description Render `docs/REMAINING_TASKS.md` with Bun's native Markdown renderer.
 *
 * Default output is ANSI for the terminal, with colour and OSC 8 links only on a TTY:
 *   bun run tasks:render
 *   bun run tasks:render --no-color --columns 100
 *   bun run tasks:render --format html --out scratch/remaining-tasks.html
 *
 * Usage:
 *   bun run scripts/render_tasks.ts [--format ansi|html] [--out <path>] [--no-color]
 *                                   [--columns N] [--source <path>]
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
const format = flag(args, ["--format"], "ansi");
const outPath = flag(args, ["--out"], "");
const columns = Math.max(
  0,
  Number(flag(args, ["--columns"], String(process.stdout.columns || 80))),
);
const noColor = args.includes("--no-color");

if (format !== "ansi" && format !== "html") {
  console.error(`tasks: unknown format "${format}" (ansi|html)`);
  process.exit(2);
}

const markdown = await Bun.file(source).text();
const unchecked = (markdown.match(/^- \[ \]/gm) ?? []).length;
const checked = (markdown.match(/^- \[x\]/gm) ?? []).length;

const rendered =
  format === "html"
    ? Bun.markdown.html(markdown, GFM)
    : (() => {
        const isTTY = process.stdout.isTTY === true;
        const light = process.env.COLORFGBG?.endsWith(";15");
        return Bun.markdown.ansi(markdown, {
          colors: !noColor && isTTY && Bun.enableANSIColors,
          hyperlinks: isTTY,
          columns,
          kittyGraphics: false,
          ...(light === undefined ? {} : { light }),
        });
      })();

if (outPath !== "") {
  await Bun.write(outPath, rendered);
  console.error(`render: ${format} -> ${outPath} (${rendered.length} bytes)`);
} else {
  process.stdout.write(rendered);
  console.error(`render: ${format} (${rendered.length} bytes)`);
}
console.error(`tasks: ${unchecked} open, ${checked} done`);

const renderedCheckboxes =
  format === "html"
    ? (rendered.match(/type="checkbox"/g) ?? []).length
    : (
        Bun.markdown
          .ansi(markdown, { colors: false, columns })
          .match(/\[[ x]\]/g) ?? []
      ).length;
if (renderedCheckboxes !== unchecked + checked) {
  console.error("checkboxes do not match markdown task count");
  process.exitCode = 1;
}
