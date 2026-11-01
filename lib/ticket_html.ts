/**
 * @file lib/ticket_html.ts
 * @description Turn printable HTML (e.g. `getTicketDetailPrint`) into text and links.
 *
 * HTMLRewriter streams and never builds a DOM. Two Bun-specific details are load-bearing here:
 * `transform()` takes a string and returns synchronously, and text nodes arrive **entity-encoded**,
 * so decoding happens after joining (an entity can span two chunks).
 */

export interface PageLink {
  readonly href: string;
  readonly text: string;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const value =
        code[1]?.toLowerCase() === "x"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return NAMED[code.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS = "p,div,tr,li,h1,h2,h3,h4,td,th,section,article";

/**
 * Remove script/style bodies before parsing.
 *
 * `element.remove()` suppresses the markup but `onDocument` still receives the removed text, so a
 * removal handler is not enough; this is the one place a targeted regex beats the streaming parser.
 */
export function stripNonContent(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
}

export function htmlToText(html: string): string {
  const chunks: string[] = [];
  const rewriter = new HTMLRewriter()
    // `<br>` is void: it has no end tag, and asking for one throws "No end tag."
    .on("br", {
      element() {
        chunks.push("\n");
      },
    })
    .on(BLOCK_TAGS, {
      element(element) {
        element.onEndTag(() => {
          chunks.push("\n");
        });
      },
    })
    .onDocument({
      text(text) {
        chunks.push(text.text);
      },
    });

  rewriter.transform(stripNonContent(html));
  return decodeEntities(chunks.join(""))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Links with their visible text; fragments with no href are dropped. */
export function extractLinks(html: string): PageLink[] {
  const links: PageLink[] = [];
  let href = "";
  let label = "";

  const rewriter = new HTMLRewriter().on("a", {
    element(element) {
      href = element.getAttribute("href") ?? "";
      label = "";
      element.onEndTag(() => {
        if (href !== "")
          links.push({ href, text: decodeEntities(label).trim() });
        href = "";
        label = "";
      });
    },
    text(text) {
      if (href !== "") label += text.text;
    },
  });

  rewriter.transform(stripNonContent(html));
  return links;
}
