import { describe, expect, test } from "bun:test";
import {
  DOC_MARKDOWN_PARSE_OPTIONS,
  extractBinaryTypeLiteralsFromMarkdown,
  extractDocMembersFromMarkdown,
  extractTypesBunMembers,
  parseLlmsFullCorpus,
  TARGETS,
} from "./diff-bun-docs-vs-types.ts";

describe("diff-bun-docs-vs-types markdown AST extraction", () => {
  test("DOC_MARKDOWN_PARSE_OPTIONS conforms to Bun.markdown.Options", () => {
    expect(DOC_MARKDOWN_PARSE_OPTIONS.noHtmlBlocks).toBe(true);
    expect(DOC_MARKDOWN_PARSE_OPTIONS.noHtmlSpans).toBe(true);
    expect(DOC_MARKDOWN_PARSE_OPTIONS.tables).toBe(true);

    // Verify partial object forms allowed by @types/bun for autolinks and headings
    const partialOptions = {
      autolinks: { url: true, email: true },
      headings: { ids: true },
    } satisfies Bun.markdown.Options;
    expect(partialOptions.autolinks).toEqual({ url: true, email: true });
    expect(partialOptions.headings).toEqual({ ids: true });
  });

  test("extracts members from code blocks, codespans, tables, headings, and MDX tabs while ignoring prose", () => {
    const md = [
      "# Image & S3 API",
      "## Metadata",
      "### img.crop(10, 10)",
      "## `file.exists()`",
      "",
      "Unbackticked prose mentioning file.fakeProseCall() and filenames like `image.png` or `file.txt` must not match.",
      "",
      "| Member | Return |",
      "| --- | --- |",
      "| `s3file.presign()` | string |",
      "| `img.width` | number |",
      "",
      "<Tabs>",
      '<Tab title="TypeScript">',
      "```ts",
      "const img = Bun.Image.from(bytes);",
      "await img.resize(120, 80);",
      "metadata();",
      "```",
      "Also call `s3File.stat()` or `img.encode({ format: 'webp' })` and `file.json()`.",
      "</Tab>",
      "</Tabs>",
    ].join("\n");

    const members = extractDocMembersFromMarkdown(md, [
      /\b(?:metadata|placeholder)\(\)/g,
    ]);

    expect([...members].sort()).toEqual([
      "crop",
      "encode",
      "exists",
      "from",
      "json",
      "metadata",
      "presign",
      "resize",
      "stat",
      "width",
    ]);
  });

  test("parseLlmsFullCorpus splits # Title + Source: URL sections cleanly", () => {
    const corpus = [
      "# UDP",
      "Source: https://bun.com/docs/runtime/networking/udp",
      "",
      "```ts",
      "socket.send('hi', 41234, '127.0.0.1');",
      "```",
      "",
      "# Archive",
      "Source: https://bun.com/docs/runtime/archive",
      "",
      "```ts",
      "const archive = new Bun.Archive({ 'a.txt': 'hi' });",
      "await archive.blob();",
      "```",
    ].join("\n");

    const pages = parseLlmsFullCorpus(corpus);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.title).toBe("UDP");
    expect(pages[0]?.url).toBe("https://bun.com/docs/runtime/networking/udp");
    expect(pages[0]?.markdown).toContain("socket.send");
    expect(pages[1]?.title).toBe("Archive");
    expect(pages[1]?.url).toBe("https://bun.com/docs/runtime/archive");
    expect(pages[1]?.markdown).toContain("archive.blob()");
  });

  test("extracts Bun.Archive, Bun.udpSocket, and BinaryType from Markdown and @types/bun", async () => {
    const udpMd = [
      "# UDP",
      "```ts",
      "const socket = await Bun.udpSocket({ binaryType: 'uint8array' });",
      "console.log(socket.port);",
      "socket.send('hi', 41234, '127.0.0.1');",
      "socket.sendMany(['a', 'b']);",
      "socket.setBroadcast(true);",
      "socket.addMembership('224.0.0.1');",
      "```",
    ].join("\n");

    const udpTarget = TARGETS.find((t) => t.id === "Bun.udpSocket")!;
    const udpDocs = extractDocMembersFromMarkdown(
      udpMd,
      udpTarget.docExtraPatterns,
      udpTarget.docReceivers,
    );
    expect([...udpDocs].sort()).toEqual([
      "addMembership",
      "port",
      "send",
      "sendMany",
      "setBroadcast",
    ]);

    const archiveMd = [
      "# Archive",
      "```ts",
      "const archive = new Bun.Archive({ 'a.txt': 'hi' });",
      "await archive.blob();",
      "await archive.bytes();",
      "await archive.files();",
      "await archive.extract('./out');",
      "await Bun.Archive.write('./out.tar.gz', { 'a.txt': 'hi' });",
      "```",
    ].join("\n");
    const archiveTarget = TARGETS.find((t) => t.id === "Bun.Archive")!;
    const archiveDocs = extractDocMembersFromMarkdown(
      archiveMd,
      archiveTarget.docExtraPatterns,
      archiveTarget.docReceivers,
    );
    expect([...archiveDocs].sort()).toEqual([
      "blob",
      "bytes",
      "extract",
      "files",
      "write",
    ]);

    const binaryLiterals = extractBinaryTypeLiteralsFromMarkdown(
      'Set `binaryType: "uint8array"` or `binaryType: "arraybuffer"` (default `binaryType: "buffer"`).',
    );
    expect([...binaryLiterals].sort()).toEqual([
      "arraybuffer",
      "buffer",
      "uint8array",
    ]);

    // Verify @types/bun declaration extraction for all 3 new targets.
    const binaryTarget = TARGETS.find((t) => t.id === "BinaryType")!;
    const [archiveTypes, udpTypes, binaryTypes] = await Promise.all([
      extractTypesBunMembers(archiveTarget.typeBlockPatterns),
      extractTypesBunMembers(udpTarget.typeBlockPatterns),
      extractTypesBunMembers(binaryTarget.typeBlockPatterns),
    ]);
    expect([...archiveTypes.members].sort()).toEqual([
      "blob",
      "bytes",
      "extract",
      "files",
      "write",
    ]);
    expect([...binaryTypes.members].sort()).toEqual([
      "arraybuffer",
      "buffer",
      "uint8array",
    ]);
    expect(udpTypes.members.has("sendMany")).toBe(true);
    expect(udpTypes.members.has("binaryType")).toBe(true);
    expect(udpTypes.members.has("reload")).toBe(true);
    expect(udpTypes.members.has("fd")).toBe(false);
  });
});
