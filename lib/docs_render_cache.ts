/**
 * @file lib/docs_render_cache.ts
 * @description Render a Markdown tree to HTML with a content-addressed cache.
 *
 * The cache key covers the Bun version, the parser options and the file bytes. Hashing only the
 * bytes (the obvious version) silently reuses HTML produced by a different renderer or a different
 * option set after an upgrade.
 *
 * `Bun.zstdCompress` returns a Promise. Both `Bun.write(path, promise)` and `promise.byteLength`
 * accept it without complaining and produce useless output, so this module only ever writes a
 * value it has awaited or produced with `Bun.zstdCompressSync`.
 */

import { Glob } from "bun";
import { rename } from "node:fs/promises";
import { join } from "node:path";

export const MAX_MARKDOWN_BYTES = 1_000_000;

/**
 * Options for documentation output: trusted content, so `noHtml*` is belt and braces rather than
 * the primary boundary, and `tagFilter` is left on for GFM compatibility. `headings` carries both
 * fields because the type requires them; `true` would also autolink every heading.
 */
export const DOCS_RENDER_OPTIONS = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
  tagFilter: true,
  noHtmlBlocks: true,
  noHtmlSpans: true,
  headings: { autolink: false, ids: true },
  collapseWhitespace: true,
} as const satisfies Bun.markdown.Options;

export interface RenderedDoc {
  /** Path relative to the scanned directory. */
  readonly rel: string;
  readonly sourceBytes: number;
  readonly htmlBytes: number;
  readonly zstdBytes: number;
  /** True when the HTML came from the cache instead of the parser. */
  readonly cached: boolean;
}

export class MarkdownTooLargeError extends Error {
  constructor(
    readonly rel: string,
    readonly bytes: number,
  ) {
    super(
      `${rel} is ${bytes} bytes (limit ${MAX_MARKDOWN_BYTES}); refusing to parse`,
    );
    this.name = "MarkdownTooLargeError";
  }
}

/**
 * sha256 over Bun version, parser options and file bytes.
 *
 * The version and option text are length-prefixed so a change in either cannot be cancelled out by
 * a change in the other (for example `1.4.4` + `{}` must not collide with `1.4` + `4{}`).
 */
export function docsCacheKey(
  bytes: Uint8Array | ArrayBuffer,
  bunVersion: string = Bun.version,
  options: Bun.markdown.Options = DOCS_RENDER_OPTIONS,
): string {
  const version = `${bunVersion}`;
  const optionsJson = JSON.stringify(options);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    `${version.length}:${version}${optionsJson.length}:${optionsJson}`,
  );
  hasher.update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  return hasher.digest("hex");
}

/** Write via a sibling temporary file so a crash cannot leave a truncated cache entry. */
async function writeAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await Bun.write(tmp, data);
  await rename(tmp, path);
}

async function renderOne(
  dir: string,
  cacheDir: string,
  rel: string,
): Promise<RenderedDoc> {
  const buffer = await Bun.file(join(dir, rel)).arrayBuffer();
  if (buffer.byteLength > MAX_MARKDOWN_BYTES) {
    throw new MarkdownTooLargeError(rel, buffer.byteLength);
  }

  const key = docsCacheKey(buffer);
  const htmlPath = join(cacheDir, `${key}.html`);
  const zstdPath = join(cacheDir, `${key}.html.zst`);

  let html: string;
  let cached: boolean;
  if (await Bun.file(htmlPath).exists()) {
    html = await Bun.file(htmlPath).text();
    cached = true;
  } else {
    html = Bun.markdown.html(buffer, DOCS_RENDER_OPTIONS);
    await writeAtomic(htmlPath, html);
    cached = false;
  }

  let zstdBytes = 0;
  const zstdFile = Bun.file(zstdPath);
  if (await zstdFile.exists()) {
    zstdBytes = zstdFile.size;
  } else {
    // Sync on purpose: the async form is a Promise, and writing that Promise stores text.
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode(html));
    await writeAtomic(zstdPath, compressed);
    zstdBytes = compressed.byteLength;
  }

  return {
    rel,
    sourceBytes: buffer.byteLength,
    htmlBytes: Buffer.byteLength(html),
    zstdBytes,
    cached,
  };
}

/**
 * Render every `**\/*.md` under `dir`.
 *
 * Files are visited in sorted order so console output and cache writes are reproducible. A file
 * over the limit fails loudly instead of being truncated or skipped.
 */
export async function renderDocsTree(options: {
  readonly dir: string;
  readonly cacheDir: string;
}): Promise<readonly RenderedDoc[]> {
  const rels: string[] = [];
  for await (const rel of new Glob("**/*.md").scan({
    cwd: options.dir,
    onlyFiles: true,
  })) {
    rels.push(rel);
  }
  rels.sort();

  const rendered: RenderedDoc[] = [];
  for (const rel of rels) {
    rendered.push(await renderOne(options.dir, options.cacheDir, rel));
  }
  return rendered;
}
