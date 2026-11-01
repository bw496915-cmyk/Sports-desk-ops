import { describe, expect, test } from "bun:test";

/**
 * What the four Markdown modes actually do with the constructs that were supposed to make HTML and
 * ANSI disagree.
 *
 * The 1.4.3 documentation says `ansi()` enables `wikiLinks`, `underline` and `latexMath` by default,
 * with no `Options` to disable them. Measured on 1.4.4: only `wikiLinks` changes anything, and only
 * when passed to `html()`. These tests pin the observed behaviour, so a Bun change surfaces here
 * instead of silently altering a rendered doc.
 */
describe("markdown mode divergence", () => {
  const SAMPLE = "__x__ and [[page]] and $x^2$";

  test("ansi leaves wiki links, underline and math literal", () => {
    const ansi = Bun.markdown
      .ansi(SAMPLE, { colors: false, columns: 0 })
      .trim();
    expect(ansi).toContain("[[page]]");
    expect(ansi).toContain("$x^2$");
    expect(ansi).not.toContain("x-wikilink");
  });

  test("html only diverges when wikiLinks is enabled", () => {
    expect(Bun.markdown.html(SAMPLE).trim()).toContain("[[page]]");
    const linked = Bun.markdown.html(SAMPLE, { wikiLinks: true });
    expect(linked).toContain('<x-wikilink data-target="page">');
  });

  test("underline and latexMath are inert for these inputs", () => {
    for (const markdown of ["__x__", "a __b__ c"]) {
      expect(Bun.markdown.html(markdown, { underline: true })).toBe(
        Bun.markdown.html(markdown),
      );
    }
    for (const markdown of ["$x^2$", "$40$", "Risk $40 and $50"]) {
      expect(Bun.markdown.html(markdown, { latexMath: true })).toBe(
        Bun.markdown.html(markdown),
      );
    }
  });

  test("render() passes text through when no callbacks are given", () => {
    expect(Bun.markdown.render(SAMPLE, {}, {})).toContain("[[page]]");
  });
});
