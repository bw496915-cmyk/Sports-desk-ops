#!/usr/bin/env bun
/**
 * @file scripts/render_docs.ts
 * @description Render a Markdown tree to HTML with a content-addressed cache.
 *
 *   bun run docs:render
 *   bun run scripts/render_docs.ts --dir docs --cache scratch/.md-cache
 *
 * The cache key includes the Bun version and the parser options, so an upgrade or an option change
 * produces new entries instead of serving HTML from a different renderer. `--check` reports stale
 * entries and exits 1 without writing, for use as a gate.
 */

import {
  DOCS_RENDER_OPTIONS,
  MarkdownTooLargeError,
  type RenderedDoc,
  renderDocsTree,
} from "../lib/docs_render_cache.ts";

function flag(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1]! : fallback;
}

const args = process.argv.slice(2);
const dir = flag(args, "--dir", "docs");
const cacheDir = flag(args, "--cache", "scratch/.md-cache");
const check = args.includes("--check");

let rendered: readonly RenderedDoc[];
try {
  rendered = await renderDocsTree({ dir, cacheDir });
} catch (error) {
  if (error instanceof MarkdownTooLargeError) {
    console.error(`docs:render: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

if (rendered.length === 0) {
  console.error(`docs:render: no Markdown files under ${dir}`);
  process.exit(2);
}

const width = process.stdout.columns ?? 0;
const stale = rendered.filter((entry) => !entry.cached).length;

for (const entry of rendered) {
  const state = entry.cached ? "cached" : "rendered";
  const line = `${entry.rel}  ${entry.sourceBytes} B -> ${entry.htmlBytes} B (zst ${entry.zstdBytes} B)  ${state}`;
  process.stdout.write(
    width > 0 ? `${Bun.wrapAnsi(line, width)}\n` : `${line}\n`,
  );
}

const total = (pick: (entry: RenderedDoc) => number): number =>
  rendered.reduce((sum, entry) => sum + pick(entry), 0);
const summary = `${rendered.length} files · src ${total((e) => e.sourceBytes)} B · html ${total((e) => e.htmlBytes)} B · zst ${total((e) => e.zstdBytes)} B · ${rendered.length - stale} cached`;
process.stderr.write(`${Bun.wrapAnsi(summary, width || 80)}\n`);
process.stderr.write(
  `docs:render: ${cacheDir} · Bun ${Bun.version} · ${JSON.stringify(DOCS_RENDER_OPTIONS).length} B options\n`,
);

if (check && stale > 0) {
  console.error(
    `docs:render: ${stale} file(s) are not cached for this Bun version and option set`,
  );
  process.exit(1);
}
