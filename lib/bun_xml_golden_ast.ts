/**
 * Mirror of dotfiles `lib/cli/bun-xml-golden-ast.ts` — standalone SportsDesk checkout.
 * Keep example ids, `compact` flags, and fixture hashes aligned with dotfiles catalog.
 */

export const BUN_XML_GOLDEN_AST_PARSE_OPTIONS = {
  compact: false,
} as const satisfies Bun.XML.ParseOptions;

export type BunXmlGoldenAstNode = Bun.XML.Node;
export type BunXmlGoldenAstDocument = Bun.XML.Document;
export type BunXmlGoldenAstParseResult =
  | BunXmlGoldenAstNode
  | BunXmlGoldenAstDocument;

export type BunXmlGoldenAstExampleId =
  | "plane1-link-id-feed"
  | "sportsdesk-board-price-100"
  | "sportsdesk-board-price-spike-250"
  | "rss-channel-title-fragment"
  | "rss-multi-item-channel-semver";

export type BunXmlGoldenAstExample = {
  id: BunXmlGoldenAstExampleId;
  xml: string;
  description: string;
  plane: "plane1" | "plane3";
  compact?: boolean;
};

export const BUN_XML_GOLDEN_AST_EXAMPLES: readonly BunXmlGoldenAstExample[] = [
  {
    id: "plane1-link-id-feed",
    plane: "plane1",
    description: "Gateway feed link_id",
    xml: "<feed><item><link_id>42</link_id></item></feed>",
  },
  {
    id: "sportsdesk-board-price-100",
    plane: "plane3",
    description: "Board price 100",
    xml: "<t><p>100</p></t>",
  },
  {
    id: "sportsdesk-board-price-spike-250",
    plane: "plane3",
    description: "Board price 250",
    xml: "<t><p>250</p></t>",
  },
  {
    id: "rss-channel-title-fragment",
    plane: "plane1",
    description: "RSS channel title",
    xml: "<rss><channel><title>Bun</title></channel></rss>",
  },
  {
    id: "rss-multi-item-channel-semver",
    plane: "plane1",
    compact: true,
    description: "bun.com RSS multi-item channel (compact Document shape)",
    xml: `<?xml version="1.0"?><rss><channel><title>bun.com</title>
<item><title>Bun v1.4.3</title><link>https://bun.com/blog/bun-v1.4.3</link></item>
<item><title>Bun v1.4.2</title><link>https://bun.com/blog/bun-v1.4.2</link></item>
</channel></rss>`,
  },
];

export function parseXmlDocumentForGoldenAst(
  xml: string,
  compact?: false,
): BunXmlGoldenAstNode;
export function parseXmlDocumentForGoldenAst(
  xml: string,
  compact: true,
): BunXmlGoldenAstDocument;
export function parseXmlDocumentForGoldenAst(
  xml: string,
  compact = false,
): BunXmlGoldenAstParseResult {
  const trimmed = xml.trim();
  if (!trimmed) throw new Error("bun-xml-golden-ast: empty XML");
  if (compact) {
    return Bun.XML.parse(trimmed, { compact: true });
  }
  return Bun.XML.parse(trimmed, BUN_XML_GOLDEN_AST_PARSE_OPTIONS);
}

export function goldenAstTextFromXml(xml: string, compact = false): string {
  const doc = compact
    ? parseXmlDocumentForGoldenAst(xml, true)
    : parseXmlDocumentForGoldenAst(xml);
  return Bun.JSON5.stringify(doc);
}

export function goldenAstFingerprintFromExample(
  example: BunXmlGoldenAstExample,
): { astText: string; sha256: string } {
  const compact = example.compact ?? false;
  const astText = goldenAstTextFromXml(example.xml, compact);
  return {
    astText,
    sha256: Bun.CryptoHasher.hash("sha256", astText, "hex"),
  };
}

export function goldenAstFingerprintFromXml(
  xml: string,
  compact = false,
): { astText: string; sha256: string } {
  const astText = goldenAstTextFromXml(xml, compact);
  return {
    astText,
    sha256: Bun.CryptoHasher.hash("sha256", astText, "hex"),
  };
}

export function xmlGoldenAstSha256ForIngest(xml: string): string {
  return goldenAstFingerprintFromXml(xml).sha256;
}
