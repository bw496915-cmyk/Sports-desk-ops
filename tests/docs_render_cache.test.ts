import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  DOCS_RENDER_OPTIONS,
  MAX_MARKDOWN_BYTES,
  MarkdownTooLargeError,
  buildDocsManifest,
  docsCacheKey,
  renderDocsTree,
} from "../lib/docs_render_cache.ts";

const ROOT = `scratch/docs-render-test-${process.pid}`;
const DIR = `${ROOT}/docs`;
const CACHE = `${ROOT}/cache`;

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("docs render cache", () => {
  test("the key covers bytes, Bun version and parser options", () => {
    const bytes = new TextEncoder().encode("# hi");
    const base = docsCacheKey(bytes, "1.4.4", DOCS_RENDER_OPTIONS);
    expect(docsCacheKey(bytes, "1.4.4", DOCS_RENDER_OPTIONS)).toBe(base);
    expect(
      docsCacheKey(
        new TextEncoder().encode("# ho"),
        "1.4.4",
        DOCS_RENDER_OPTIONS,
      ),
    ).not.toBe(base);
    expect(docsCacheKey(bytes, "1.4.5", DOCS_RENDER_OPTIONS)).not.toBe(base);
    expect(
      docsCacheKey(bytes, "1.4.4", { ...DOCS_RENDER_OPTIONS, tables: false }),
    ).not.toBe(base);
  });

  test("renders HTML and a decompressable zstd artifact", async () => {
    await Bun.write(
      `${DIR}/a.md`,
      "# Title\n\n| A |\n| - |\n| 1 |\n\n<img src=x onerror=1>\n",
    );
    const [entry] = await renderDocsTree({ dir: DIR, cacheDir: CACHE });
    expect(entry?.rel).toBe("a.md");
    expect(entry?.cached).toBe(false);

    const key = docsCacheKey(
      new Uint8Array(await Bun.file(`${DIR}/a.md`).arrayBuffer()),
      Bun.version,
      DOCS_RENDER_OPTIONS,
    );
    const html = await Bun.file(`${CACHE}/${key}.html`).text();
    expect(html).toContain("<table>");
    expect(html).not.toContain("<img");

    const compressed = new Uint8Array(
      await Bun.file(`${CACHE}/${key}.html.zst`).arrayBuffer(),
    );
    const inflated = Bun.zstdDecompressSync(compressed);
    expect(new TextDecoder().decode(inflated)).toBe(html);
    expect(entry?.zstdBytes).toBe(compressed.byteLength);
    expect(entry?.htmlBytes).toBe(Buffer.byteLength(html));
    expect(entry?.sourceBytes).toBe(
      (await Bun.file(`${DIR}/a.md`).stat()).size,
    );
  });

  test("a second run reports cached and rewrites nothing", async () => {
    const [first] = await renderDocsTree({ dir: DIR, cacheDir: CACHE });
    const key = docsCacheKey(
      new Uint8Array(await Bun.file(`${DIR}/a.md`).arrayBuffer()),
      Bun.version,
      DOCS_RENDER_OPTIONS,
    );
    const htmlBefore = await Bun.file(`${CACHE}/${key}.html`).stat();
    const [second] = await renderDocsTree({ dir: DIR, cacheDir: CACHE });
    const htmlAfter = await Bun.file(`${CACHE}/${key}.html`).stat();
    expect(first?.cached).toBe(true);
    expect(second?.cached).toBe(true);
    expect(htmlAfter.mtimeMs).toBe(htmlBefore.mtimeMs);
    expect(second?.zstdBytes).toBe(first?.zstdBytes);
  });

  test("editing a file creates a new entry instead of overwriting the old one", async () => {
    const before = await renderDocsTree({ dir: DIR, cacheDir: CACHE });
    await Bun.write(`${DIR}/a.md`, "# Changed\n");
    const after = await renderDocsTree({ dir: DIR, cacheDir: CACHE });
    expect(after[0]?.cached).toBe(false);
    expect(after[0]?.htmlBytes).not.toBe(before[0]?.htmlBytes);
    const entries = [
      ...new Bun.Glob("*.html").scanSync({ cwd: CACHE, onlyFiles: true }),
    ].filter((name) => !name.endsWith(".html.zst"));
    expect(entries.length).toBe(2);
  });

  test("refuses files over the limit without writing a cache entry", async () => {
    await Bun.write(`${DIR}/big.md`, "#".repeat(MAX_MARKDOWN_BYTES + 1));
    const entriesBefore = [...new Bun.Glob("*").scanSync({ cwd: CACHE })]
      .length;
    await expect(
      renderDocsTree({ dir: DIR, cacheDir: CACHE }),
    ).rejects.toBeInstanceOf(MarkdownTooLargeError);
    const entriesAfter = [...new Bun.Glob("*").scanSync({ cwd: CACHE })].length;
    expect(entriesAfter).toBe(entriesBefore);
    await Bun.file(`${DIR}/big.md`).delete();
  });

  test("the manifest is deterministic and merges identical content", () => {
    const rendered = [
      {
        key: "b",
        rel: "z.md",
        sourceBytes: 1,
        htmlBytes: 10,
        zstdBytes: 5,
        cached: true,
      },
      {
        key: "a",
        rel: "b.md",
        sourceBytes: 1,
        htmlBytes: 20,
        zstdBytes: 6,
        cached: true,
      },
      {
        key: "a",
        rel: "a.md",
        sourceBytes: 1,
        htmlBytes: 20,
        zstdBytes: 6,
        cached: true,
      },
    ];
    const first = buildDocsManifest(rendered);
    const second = buildDocsManifest([...rendered].reverse());
    expect(first.buildId).toBe(second.buildId);
    expect(Object.keys(first.entries)).toEqual(["a", "b"]);
    expect(first.entries["a"]?.sources).toEqual(["a.md", "b.md"]);
    expect(first.buildId).toHaveLength(64);
  });

  test("dryRun computes without writing", async () => {
    const dir = `${ROOT}/dry/docs`;
    const cache = `${ROOT}/dry/cache`;
    await Bun.write(`${dir}/x.md`, "# X\n");
    const [entry] = await renderDocsTree({
      dir,
      cacheDir: cache,
      dryRun: true,
    });
    expect(entry?.cached).toBe(false);
    expect(await Bun.file(`${cache}/${entry?.key}.html`).exists()).toBe(false);
    expect(await Bun.file(`${cache}/${entry?.key}.html.zst`).exists()).toBe(
      false,
    );
  });
});
