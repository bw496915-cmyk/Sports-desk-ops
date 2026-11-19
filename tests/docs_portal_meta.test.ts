import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The two published portal pages are hand-maintained, and nothing verified their `<head>` beyond
 * `docs/index.html`'s Scalar pin. These cases pin the metadata and landmark structure both pages
 * need: a real title and description, a canonical URL and Open Graph/Twitter preview, and an
 * identified `<header>` so the document has landmarks to link to.
 *
 * The canonical origin is the R2 public gateway the pages are actually served from — both URLs were
 * fetched and returned 200 before being written into the markup, so this is not a guessed host.
 */

const ROOT = join(import.meta.dir, "..");
const PAGES = [
  { file: "docs/index.html", slug: "index.html" },
  { file: "docs/graph.html", slug: "graph.html" },
] as const;

const ORIGIN = "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";

function attr(html: string, pattern: RegExp): string | null {
  return pattern.exec(html)?.[1]?.trim() ?? null;
}

describe.each(PAGES)("$file head and landmarks", ({ file, slug }) => {
  test("declares a language, charset, viewport, title and description", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<meta charset="utf-8"\s*\/?>/);
    expect(html).toMatch(/name="viewport"/);
    expect(attr(html, /<title>([\s\S]*?)<\/title>/)).toBeTruthy();
    expect(attr(html, /name="description"\s+content="([^"]+)"/)).toBeTruthy();
  });

  test("carries a canonical URL and a social preview that agree", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    const canonical = attr(html, /rel="canonical"\s+href="([^"]+)"/);
    expect(canonical).toBe(`${ORIGIN}/${slug}`);

    expect(attr(html, /property="og:type"\s+content="([^"]+)"/)).toBe(
      "website",
    );
    expect(attr(html, /property="og:title"\s+content="([^"]+)"/)).toBeTruthy();
    expect(
      attr(html, /property="og:description"\s+content="([^"]+)"/),
    ).toBeTruthy();
    expect(attr(html, /property="og:url"\s+content="([^"]+)"/)).toBe(canonical);
    expect(attr(html, /name="twitter:card"\s+content="([^"]+)"/)).toBe(
      "summary",
    );
  });

  test("the social title matches the document title", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    const title = attr(html, /<title>([\s\S]*?)<\/title>/);
    const ogTitle = attr(html, /property="og:title"\s+content="([^"]+)"/);
    expect(ogTitle).toBe(title);
  });

  test("has an identified header landmark", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    expect(html).toMatch(/<header[\s\S]{0,120}?id="[a-z-]+"/);
  });
});

describe("docs/index.html landmarks", () => {
  test("the header nav and the reference mount are identified", async () => {
    const html = await Bun.file(join(ROOT, "docs/index.html")).text();
    expect(html).toMatch(/id="spec-banner"/);
    expect(html).toMatch(/<nav[\s\S]{0,160}?id="spec-nav"/);
    expect(html).toMatch(/<main id="reference" class="reference-root">/);
    // The Scalar mount must stay the element Scalar looks for.
    expect(html).toMatch(/id="api-reference"/);
    expect(html).toMatch(/data-url="\.\/openapi\.json"/);
  });
});
