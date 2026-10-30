/**
 * Mirror of dotfiles `lib/cli/bun-xml-golden-ast.ts` — standalone SportsDesk checkout.
 * Keep example ids and fixture hashes aligned with dotfiles catalog.
 */

export const BUN_XML_GOLDEN_AST_PARSE_OPTIONS = {
  compact: false,
} as const;

export type BunXmlGoldenAstElement = {
  name: string;
  attributes: Record<string, string>;
  children: Array<BunXmlGoldenAstElement | string>;
};

export type BunXmlGoldenAstExampleId =
  | "plane1-link-id-feed"
  | "sportsdesk-board-price-100"
  | "sportsdesk-board-price-spike-250"
  | "rss-channel-title-fragment";

export const BUN_XML_GOLDEN_AST_EXAMPLES = [
  {
    id: "plane1-link-id-feed" as const,
    plane: "plane1" as const,
    description: "Gateway feed link_id",
    xml: "<feed><item><link_id>42</link_id></item></feed>",
  },
  {
    id: "sportsdesk-board-price-100" as const,
    plane: "plane3" as const,
    description: "Board price 100",
    xml: "<t><p>100</p></t>",
  },
  {
    id: "sportsdesk-board-price-spike-250" as const,
    plane: "plane3" as const,
    description: "Board price 250",
    xml: "<t><p>250</p></t>",
  },
  {
    id: "rss-channel-title-fragment" as const,
    plane: "plane1" as const,
    description: "RSS channel title",
    xml: "<rss><channel><title>Bun</title></channel></rss>",
  },
] as const;

export function parseXmlDocumentForGoldenAst(
  xml: string,
): BunXmlGoldenAstElement {
  const trimmed = xml.trim();
  if (!trimmed) throw new Error("bun-xml-golden-ast: empty XML");
  return Bun.XML.parse(trimmed, BUN_XML_GOLDEN_AST_PARSE_OPTIONS) as BunXmlGoldenAstElement;
}

export function goldenAstTextFromXml(xml: string): string {
  return Bun.JSON5.stringify(parseXmlDocumentForGoldenAst(xml));
}

export function goldenAstFingerprintFromXml(xml: string): {
  astText: string;
  sha256: string;
} {
  const astText = goldenAstTextFromXml(xml);
  return {
    astText,
    sha256: Bun.CryptoHasher.hash("sha256", astText, "hex"),
  };
}

export function xmlGoldenAstSha256ForIngest(xml: string): string {
  return goldenAstFingerprintFromXml(xml).sha256;
}
