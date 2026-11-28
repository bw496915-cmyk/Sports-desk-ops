// scripts/diff-bun-docs-vs-types.ts
// Usage:
//   bun run scripts/diff-bun-docs-vs-types.ts
//   bun run scripts/diff-bun-docs-vs-types.ts --target=Bun.udpSocket,Bun.Archive,BinaryType
//   R2_SNAPSHOT=1 bun run scripts/diff-bun-docs-vs-types.ts --strict

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const LLMS_FULL_URL = "https://bun.sh/llms-full.txt";
const LLMS_INDEX_URL = "https://bun.sh/llms.txt";
const STRICT = Bun.argv.includes("--strict");
const JSON_OUT = Bun.argv.includes("--json");
const WRITE_R2 = Bun.env.R2_SNAPSHOT === "1";

export type TargetId =
  "Bun.Image" | "S3File" | "Bun.Archive" | "Bun.udpSocket" | "BinaryType";

export interface LlmsLink {
  title: string;
  url: string;
  normalizedUrl: string;
}

export interface LlmsFullPage extends LlmsLink {
  markdown: string;
}

export interface TargetSpec {
  readonly id: TargetId;
  readonly linkPattern: RegExp;
  readonly typeBlockPatterns: readonly RegExp[];
  /** Custom receiver names (e.g. `["archive", "Bun.Archive"]`) for receiver.member extraction. */
  readonly docReceivers?: readonly string[];
  /** Bare or static calls the docs write without a receiver (no generic `.foo()` rule). */
  readonly docExtraPatterns?: readonly RegExp[];
  /** Optional custom Markdown extractor (used by literal-union targets like `BinaryType`). */
  readonly extractDocMembers?: (md: string) => Set<string>;
  readonly getRuntimeMembers: () => Set<string> | Promise<Set<string>>;
}

const BINARY_TYPE_CANDIDATES = [
  "arraybuffer",
  "blob",
  "buffer",
  "dataview",
  "nodebuffer",
  "uint8array",
] as const;

/**
 * Extracts documented `binaryType` string literals (e.g. `binaryType: "uint8array"`,
 * `binaryType = "arraybuffer"`) from Markdown code blocks and codespans.
 */
export function extractBinaryTypeLiteralsFromMarkdown(md: string): Set<string> {
  const found = new Set<string>();
  const assignRe = /\bbinaryType\s*(?::|=)\s*["']([a-z0-9_-]+)["']/gi;
  const unionRe =
    /\bbinaryType\b[^\n]{0,120}?(["'](?:arraybuffer|buffer|uint8array|dataview|nodebuffer|blob)["'])/gi;
  const quotedCandidateRe =
    /["'](arraybuffer|buffer|uint8array|dataview|nodebuffer|blob)["']/gi;

  const scan = (chunk: string): void => {
    assignRe.lastIndex = 0;
    for (const [, val] of chunk.matchAll(assignRe)) {
      if (val !== undefined) found.add(val.toLowerCase());
    }
    if (/\bbinaryType\b/i.test(chunk)) {
      unionRe.lastIndex = 0;
      for (const line of chunk.split("\n")) {
        if (!/\bbinaryType\b/i.test(line)) continue;
        quotedCandidateRe.lastIndex = 0;
        for (const [, val] of line.matchAll(quotedCandidateRe)) {
          if (val !== undefined) found.add(val.toLowerCase());
        }
      }
    }
  };

  // trusted-markdown: AST callback scan over docs markdown; returns "".
  Bun.markdown.render(
    md,
    {
      code(children) {
        scan(children);
        return "";
      },
      codespan(children) {
        scan(children);
        return children;
      },
      heading(children) {
        scan(children);
        return "";
      },
      paragraph(children) {
        scan(children);
        return "";
      },
      html() {
        return "";
      },
    },
    DOC_MARKDOWN_PARSE_OPTIONS,
  );

  return found;
}

export const TARGETS: readonly TargetSpec[] = [
  {
    id: "Bun.Image",
    linkPattern: /\b(bun\.image|\/image(\.md|\/|$)|image\s+api)\b/i,
    typeBlockPatterns: [
      /\b(?:export\s+)?class\s+Image\b[^{]*\{/g,
      /\b(?:export\s+)?interface\s+Image\b[^{]*\{/g,
    ],
    docReceivers: ["Bun.Image", "Image", "image", "img", "myImage"],
    docExtraPatterns: [
      /\b(?:clipboardChangeCount|hasClipboardImage|metadata|placeholder)\(\)/g,
    ],
    getRuntimeMembers: () => {
      const ctor = (Bun as Record<string, unknown>).Image as
        { prototype?: object } | undefined;
      if (!ctor) return new Set();
      return new Set([
        ...Object.getOwnPropertyNames(ctor).filter(
          (k) => !["length", "name", "prototype"].includes(k),
        ),
        ...(ctor.prototype
          ? Object.getOwnPropertyNames(ctor.prototype).filter(
              (k) => k !== "constructor",
            )
          : []),
      ]);
    },
  },
  {
    id: "S3File",
    linkPattern: /\b(s3file|\/s3(\.md|\/|$)|s3\s+api)\b/i,
    // S3File extends Blob, so its declared type surface includes the Blob members too.
    typeBlockPatterns: [
      /\b(?:export\s+)?interface\s+S3File\b[^{]*\{/g,
      /\binterface\s+Blob\b[^{]*\{/g,
    ],
    docReceivers: ["s3file", "s3File", "file", "myFile"],
    getRuntimeMembers: () => {
      try {
        const probe = Bun.s3.file("__ast_probe__");
        const proto = Object.getPrototypeOf(probe);
        if (!proto) return new Set();
        return new Set(
          Object.getOwnPropertyNames(proto).filter((k) => k !== "constructor"),
        );
      } catch {
        return new Set();
      }
    },
  },
  {
    id: "Bun.Archive",
    linkPattern: /\b(bun\.archive|\/runtime\/archive(\.md|\/|$))\b/i,
    typeBlockPatterns: [/\b(?:export\s+)?class\s+Archive\b[^{]*\{/g],
    docReceivers: ["Bun.Archive", "Archive", "archive", "tarball"],
    docExtraPatterns: [/\b(?:blob|bytes|extract|files|write)\(\)/g],
    getRuntimeMembers: () => {
      const ctor = (Bun as Record<string, unknown>).Archive as
        { prototype?: object } | undefined;
      if (!ctor) return new Set();
      return new Set([
        ...Object.getOwnPropertyNames(ctor).filter(
          (k) => !["length", "name", "prototype"].includes(k),
        ),
        ...(ctor.prototype
          ? Object.getOwnPropertyNames(ctor.prototype).filter(
              (k) => k !== "constructor",
            )
          : []),
      ]);
    },
  },
  {
    id: "Bun.udpSocket",
    linkPattern: /\b(udpsocket|\/runtime\/networking\/udp(\.md|\/|$))\b/i,
    typeBlockPatterns: [
      /\bexport\s+interface\s+BaseUDPSocket\b[^{]*\{/g,
      /\bexport\s+interface\s+Socket<DataBinaryType\b[^{]*\{/g,
      /\bexport\s+interface\s+ConnectedSocket<DataBinaryType\b[^{]*\{/g,
    ],
    docReceivers: ["socket", "server", "client", "udp"],
    docExtraPatterns: [
      /\b(?:send|sendMany|close|reload|setBroadcast|setTTL|addMembership|dropMembership|setMulticastTTL|setMulticastLoopback|setMulticastInterface|addSourceSpecificMembership|dropSourceSpecificMembership)\(\)/g,
    ],
    getRuntimeMembers: async () => {
      try {
        const probe = await Bun.udpSocket({
          hostname: "127.0.0.1",
          port: 0,
          socket: { data() {} },
        });
        try {
          const proto = Object.getPrototypeOf(probe);
          if (!proto) return new Set();
          return new Set(
            Object.getOwnPropertyNames(proto).filter(
              (k) => k !== "constructor",
            ),
          );
        } finally {
          probe.close();
        }
      } catch {
        return new Set();
      }
    },
  },
  {
    id: "BinaryType",
    linkPattern: /\/runtime\/networking\/(tcp|udp)(\.md|\/|$)/i,
    typeBlockPatterns: [/\binterface\s+BinaryTypeList\b[^{]*\{/g],
    extractDocMembers: extractBinaryTypeLiteralsFromMarkdown,
    getRuntimeMembers: async () => {
      const accepted = new Set<string>();
      for (const candidate of BINARY_TYPE_CANDIDATES) {
        try {
          const tcp = Bun.listen({
            hostname: "127.0.0.1",
            port: 0,
            socket: { binaryType: candidate as never, data() {} },
          });
          tcp.stop(true);
          accepted.add(candidate);
        } catch {
          // Rejected by TCP SocketHandler.binaryType.
        }
      }
      return accepted;
    },
  },
];

/**
 * Splits `https://bun.sh/llms-full.txt` into per-page `{ title, url, normalizedUrl, markdown }`
 * records using its `# <Title>\nSource: <url>` page boundaries.
 */
export function parseLlmsFullCorpus(text: string): LlmsFullPage[] {
  const headerRe = /^# ([^\n]+)\nSource: (https?:\/\/[^\s]+)/gm;
  const matches = [...text.matchAll(headerRe)];
  const pages: LlmsFullPage[] = [];

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const title = cur[1]?.trim();
    const url = cur[2]?.trim();
    if (!title || !url || cur.index === undefined) continue;
    const endIdx = matches[i + 1]?.index ?? text.length;
    pages.push({
      title,
      url,
      normalizedUrl: url.replace(/\/index\.md$/, ".md"),
      markdown: text.slice(cur.index, endIdx).trim(),
    });
  }

  return pages;
}

// 1. Fetch & SHA-256 snapshot bun.sh/llms-full.txt (fallback: bun.sh/llms.txt)
async function fetchLlmsSnapshot() {
  const res = await fetch(LLMS_FULL_URL, {
    headers: { Accept: "text/plain;q=0.9,*/*;q=0.8" },
    redirect: "follow",
  });
  if (res.ok) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const text = new TextDecoder().decode(bytes);
    const pages = parseLlmsFullCorpus(text);

    const r2Key = `snapshots/bun-llms-full/${sha256}.txt`;
    if (WRITE_R2) {
      await Bun.s3.file(r2Key).write(bytes, {
        type: "text/plain; charset=utf-8",
      });
    }

    return {
      source: LLMS_FULL_URL,
      sha256,
      bytes: bytes.byteLength,
      deployment: res.headers.get("x-version") ?? "unknown",
      mintlify: res.headers.get("x-mintlify-client-version") ?? "unknown",
      r2Key: WRITE_R2 ? r2Key : null,
      pages,
      links: pages.map(({ title, url, normalizedUrl }) => ({
        title,
        url,
        normalizedUrl,
      })),
    };
  }

  const indexRes = await fetch(LLMS_INDEX_URL, {
    headers: { Accept: "text/plain;q=0.9,*/*;q=0.8" },
    redirect: "follow",
  });
  if (!indexRes.ok) {
    throw new Error(
      `llms-full.txt (${res.status}) and llms.txt (${indexRes.status}) fetches failed`,
    );
  }
  const bytes = new Uint8Array(await indexRes.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const text = new TextDecoder().decode(bytes);

  const r2Key = `snapshots/bun-llms/${sha256}.txt`;
  if (WRITE_R2) {
    await Bun.s3.file(r2Key).write(bytes, {
      type: "text/plain; charset=utf-8",
    });
  }

  const links: LlmsLink[] = [];
  for (const [, title, url] of text.matchAll(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
  )) {
    if (title === undefined || url === undefined) continue;
    links.push({
      title: title.trim(),
      url,
      normalizedUrl: url.replace(/\/index\.md$/, ".md"),
    });
  }

  return {
    source: LLMS_INDEX_URL,
    sha256,
    bytes: bytes.byteLength,
    deployment: indexRes.headers.get("x-version") ?? "unknown",
    mintlify: indexRes.headers.get("x-mintlify-client-version") ?? "unknown",
    r2Key: WRITE_R2 ? r2Key : null,
    pages: null as LlmsFullPage[] | null,
    links,
  };
}

/**
 * Markdown parser options passed to `Bun.markdown.render()` for doc extraction.
 * Disables raw HTML blocks/spans so MDX tags (e.g. `<Tabs><Tab>`) do not hide nested
 * code fences/spans, while keeping GFM tables enabled for API summary tables.
 */
export const DOC_MARKDOWN_PARSE_OPTIONS = {
  noHtmlBlocks: true,
  noHtmlSpans: true,
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: false,
  headings: false,
  tagFilter: false,
} as const satisfies Bun.markdown.Options;

const DEFAULT_DOC_RECEIVERS = [
  "Bun.Image",
  "Image",
  "img",
  "image",
  "myImage",
  "s3file",
  "s3File",
  "file",
  "myFile",
] as const;

const NON_MEMBER_FILE_EXTS = new Set([
  "avif",
  "bmp",
  "gif",
  "gz",
  "ico",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "md",
  "png",
  "svg",
  "tar",
  "toml",
  "ts",
  "tsx",
  "txt",
  "webp",
  "yaml",
]);

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildReceiverRegexes(receivers: readonly string[]): {
  backtickMemberRe: RegExp;
  callRe: RegExp;
  propRe: RegExp;
} {
  const alt = receivers.map(escapeRegExp).join("|");
  return {
    backtickMemberRe: new RegExp(
      `^(?:${alt})\\.([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\\(\\))?$`,
    ),
    callRe: new RegExp(
      `\\b(?:${alt})\\.([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*\\(`,
      "g",
    ),
    propRe: new RegExp(
      `\\b(?:${alt})\\.([a-zA-Z_$][a-zA-Z0-9_$]*)\\b(?!\\s*\\()`,
      "g",
    ),
  };
}

function collectPatterns(
  source: string,
  callRe: RegExp,
  propRe: RegExp,
  extraPatterns: readonly RegExp[],
  members: Set<string>,
  collectProps: boolean,
): void {
  callRe.lastIndex = 0;
  for (const [, name] of source.matchAll(callRe)) {
    if (name !== undefined) members.add(name);
  }
  if (collectProps) {
    propRe.lastIndex = 0;
    for (const [, name] of source.matchAll(propRe)) {
      if (name !== undefined && !NON_MEMBER_FILE_EXTS.has(name)) {
        members.add(name);
      }
    }
  }
  for (const re of extraPatterns) {
    re.lastIndex = 0;
    for (const [match] of source.matchAll(re)) {
      // Target-owned patterns name the member literally; take the last identifier token.
      const name = match.match(/[a-zA-Z_$][a-zA-Z0-9_$]*(?=\(\))/g)?.at(-1);
      if (name !== undefined) members.add(name);
    }
  }
}

/**
 * Extracts documented member identifiers from a Markdown document by walking
 * `Bun.markdown.render()` AST callbacks (`code`, `codespan`, `heading`) rather
 * than regex-scanning raw prose.
 */
export function extractDocMembersFromMarkdown(
  md: string,
  extraPatterns: readonly RegExp[] = [],
  receivers: readonly string[] = DEFAULT_DOC_RECEIVERS,
): Set<string> {
  const members = new Set<string>();
  const { backtickMemberRe, callRe, propRe } = buildReceiverRegexes(receivers);
  const collectPropsInCode = receivers !== DEFAULT_DOC_RECEIVERS;

  // trusted-markdown: parser pass over docs markdown; every callback returns "" (no output).
  Bun.markdown.render(
    md,
    {
      code(children) {
        collectPatterns(
          children,
          callRe,
          propRe,
          extraPatterns,
          members,
          collectPropsInCode,
        );
        return "";
      },
      codespan(children) {
        const trimmed = children.trim();
        const backtickMatch = trimmed.match(backtickMemberRe);
        if (backtickMatch?.[1] !== undefined) {
          const hasParens = trimmed.endsWith("()");
          if (hasParens || !NON_MEMBER_FILE_EXTS.has(backtickMatch[1])) {
            members.add(backtickMatch[1]);
          }
        }
        collectPatterns(trimmed, callRe, propRe, extraPatterns, members, false);
        return children;
      },
      heading(children) {
        // Plain section titles (e.g. "## Metadata", "## Clipboard") are ignored;
        // backticked members inside headings are handled by `codespan`, and explicit
        // receiver calls in headings (e.g. "### img.resize()") are still picked up.
        callRe.lastIndex = 0;
        for (const [, name] of children.matchAll(callRe)) {
          if (name !== undefined) members.add(name);
        }
        return "";
      },
      paragraph() {
        return "";
      },
      html() {
        return "";
      },
    },
    DOC_MARKDOWN_PARSE_OPTIONS,
  );

  return members;
}

// 2. Extract documented member identifiers from llms-full pages (or fetched .md pages)
async function extractDocMembers(
  target: TargetSpec,
  matchedPages: readonly LlmsFullPage[] | null,
  matchedLinks: readonly LlmsLink[],
): Promise<{
  members: Set<string>;
  fetchedUrls: string[];
  failedUrls: string[];
}> {
  const members = new Set<string>();
  const fetchedUrls: string[] = [];
  const failedUrls: string[] = [];

  const extractOne = (md: string): Set<string> =>
    target.extractDocMembers
      ? target.extractDocMembers(md)
      : extractDocMembersFromMarkdown(
          md,
          target.docExtraPatterns ?? [],
          target.docReceivers ?? DEFAULT_DOC_RECEIVERS,
        );

  if (matchedPages !== null) {
    for (const page of matchedPages) {
      fetchedUrls.push(page.url);
      for (const name of extractOne(page.markdown)) {
        members.add(name);
      }
    }
    return { members, fetchedUrls, failedUrls };
  }

  const uniqueUrls = [...new Set(matchedLinks.map((l) => l.normalizedUrl))];
  await Promise.all(
    uniqueUrls.map(async (url) => {
      const res = await fetch(url, {
        headers: { Accept: "text/markdown,text/plain;q=0.9,*/*;q=0.8" },
        redirect: "follow",
      });
      if (!res.ok) {
        failedUrls.push(`${res.status} ${url}`);
        return;
      }
      fetchedUrls.push(url);
      const md = await res.text();
      for (const name of extractOne(md)) {
        members.add(name);
      }
    }),
  );

  return { members, fetchedUrls, failedUrls };
}

// 3. Extract @types/bun declaration members via brace-balanced .d.ts scan
function extractBalancedBlock(source: string, openBraceIdx: number): string {
  let depth = 0;
  for (let i = openBraceIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(openBraceIdx + 1, i);
    }
  }
  return "";
}

export function parseMembersFromBlock(block: string): string[] {
  // Strip block comments and line comments
  const cleaned = block
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  const names: string[] = [];
  // Only capture top-level members inside the interface/class body (depth 0)
  let depth = 0;
  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim();
    if (depth === 0 && line.length > 0) {
      const m = line.match(
        /^(?:readonly\s+|static\s+|public\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\??\s*(?:<[^>]+>)?\s*[:(]/,
      );
      if (m?.[1] !== undefined && m[1] !== "constructor") {
        names.push(m[1]);
      }
    }
    for (const ch of line) {
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
    }
  }
  return names;
}

export async function extractTypesBunMembers(
  patterns: readonly RegExp[],
): Promise<{ typesVersion: string; members: Set<string> }> {
  const pkgPath = Bun.resolveSync("@types/bun/package.json", process.cwd());
  const pkg = (await Bun.file(pkgPath).json()) as { version?: string };
  // @types/bun is only `/// <reference types="bun-types" />`; the declarations live in the
  // sibling `bun-types` package of the realpath'd install (Bun's global store link). Resolving
  // from the symlink path fails, so follow it first.
  const typesRoot = realpathSync(dirname(pkgPath));
  const bunTypesPath = Bun.resolveSync("bun-types/package.json", typesRoot);
  const rootDir = dirname(bunTypesPath);

  const glob = new Bun.Glob("**/*.d.ts");
  const members = new Set<string>();

  for await (const relPath of glob.scan({ cwd: rootDir })) {
    const content = await Bun.file(join(rootDir, relPath)).text();
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const match of content.matchAll(re)) {
        const openIdx = match.index! + match[0].length - 1;
        const block = extractBalancedBlock(content, openIdx);
        for (const name of parseMembersFromBlock(block)) {
          members.add(name);
        }
      }
    }
  }

  return { typesVersion: String(pkg.version ?? "unknown"), members };
}

function selectTargets(): readonly TargetSpec[] {
  const arg = Bun.argv.find((a) => a.startsWith("--target="));
  if (!arg) return TARGETS;
  const wanted = new Set(
    arg
      .slice("--target=".length)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const filtered = TARGETS.filter((t) => wanted.has(t.id.toLowerCase()));
  if (filtered.length === 0) {
    throw new Error(
      `Unknown --target value. Available: ${TARGETS.map((t) => t.id).join(", ")}`,
    );
  }
  return filtered;
}

// 4. Execute 3-way diff: Docs (llms-full.txt) vs @types/bun vs Runtime
async function main(): Promise<void> {
  const snapshot = await fetchLlmsSnapshot();
  const activeTargets = selectTargets();

  const summaryMeta = {
    bunRuntime: Bun.version_with_sha,
    docsSource: snapshot.source,
    llmsSha256: snapshot.sha256,
    llmsBytes: snapshot.bytes,
    deployment: snapshot.deployment,
    mintlify: snapshot.mintlify,
    r2SnapshotKey: snapshot.r2Key,
    totalPages: snapshot.pages ? snapshot.pages.length : snapshot.links.length,
    targets: activeTargets.map((t) => t.id),
  };

  if (!JSON_OUT) {
    console.log(summaryMeta);
  }

  let hasDrift = false;
  const jsonTargets: Array<{
    readonly id: TargetId;
    readonly typesVersion: string;
    readonly matchedDocPages: readonly string[];
    readonly failedDocPages: readonly string[];
    readonly counts: {
      readonly docs: number;
      readonly types: number;
      readonly runtime: number;
    };
    readonly rows: ReadonlyArray<{
      readonly symbol: string;
      readonly docs: string;
      readonly types: string;
      readonly runtime: string;
      readonly status: string;
    }>;
  }> = [];

  for (const target of activeTargets) {
    const matchedPages =
      snapshot.pages === null
        ? null
        : snapshot.pages.filter((p) =>
            target.linkPattern.test(`${p.title} ${p.url}`),
          );
    const matchedLinks = snapshot.links.filter((l) =>
      target.linkPattern.test(`${l.title} ${l.url}`),
    );

    const [docs, types, runtime] = await Promise.all([
      extractDocMembers(target, matchedPages, matchedLinks),
      extractTypesBunMembers(target.typeBlockPatterns),
      Promise.resolve(target.getRuntimeMembers()),
    ]);

    const union = [
      ...new Set([...docs.members, ...types.members, ...runtime]),
    ].sort();
    const rows = union.map((symbol) => {
      const inDocs = docs.members.has(symbol);
      const inTypes = types.members.has(symbol);
      const inRuntime = runtime.has(symbol);
      const status =
        inDocs && inTypes && inRuntime
          ? "SYNC"
          : inTypes && inRuntime && !inDocs
            ? "UNDOCUMENTED"
            : inDocs && !inTypes
              ? "MISSING_IN_TYPES"
              : inTypes && !inRuntime
                ? "TYPES_ONLY"
                : "RUNTIME_ONLY";
      if (status !== "SYNC") hasDrift = true;
      return {
        symbol,
        docs: inDocs ? "✓" : "—",
        types: inTypes ? "✓" : "—",
        runtime: inRuntime ? "✓" : "—",
        status,
      };
    });

    const targetReport = {
      id: target.id,
      typesVersion: types.typesVersion,
      matchedDocPages: docs.fetchedUrls,
      failedDocPages: docs.failedUrls,
      counts: {
        docs: docs.members.size,
        types: types.members.size,
        runtime: runtime.size,
      },
      rows,
    };
    jsonTargets.push(targetReport);

    if (!JSON_OUT) {
      console.log(`\n=== ${target.id} (@types/bun@${types.typesVersion}) ===`);
      console.log({
        matchedDocPages: targetReport.matchedDocPages,
        failedDocPages: targetReport.failedDocPages,
        counts: targetReport.counts,
      });
      console.table(rows);
    }
  }

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        { ...summaryMeta, hasDrift, results: jsonTargets },
        null,
        2,
      ),
    );
  }

  if (STRICT && hasDrift) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
