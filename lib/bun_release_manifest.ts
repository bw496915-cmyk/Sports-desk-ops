/**
 * @file lib/bun_release_manifest.ts
 * @description Vendored Bun release notes: manifest schema, verbatim-quote validation, digest
 * rendering and the repo surface scan behind `bun run bun:release`.
 *
 * Layout per release (docs/vendor/bun/README.md):
 *   <version>.md            upstream blog markdown, byte-for-byte (sha256 pinned in the manifest)
 *   <version>.changes.yaml  one entry per change, quoting the doc verbatim
 *   <version>.digest.md     generated from the manifest: breaking, deprecation and security only
 */

import { z } from "zod";

export const BUN_VENDOR_DIR = "docs/vendor/bun";

export const CHANGE_KINDS = [
  "security",
  "breaking",
  "deprecation",
  "perf",
  "new",
  "fix",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Kinds an upgrade audit reviews by default; the rest need an explicit opt-in. */
export const AUDIT_KINDS: readonly ChangeKind[] = [
  "security",
  "breaking",
  "deprecation",
];

const KIND_CODE: Record<ChangeKind, string> = {
  security: "SEC",
  breaking: "BRK",
  deprecation: "DEP",
  perf: "PRF",
  new: "NEW",
  fix: "FIX",
};

const Quote = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const ChangeSchema = z
  .strictObject({
    id: z.string().regex(/^BUN\d+-(SEC|BRK|DEP|PRF|NEW|FIX)-\d{3}$/),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    kind: z.enum(CHANGE_KINDS),
    section: z.string().regex(/^#{1,6} \S/),
    surface: z.array(z.string().min(1)).min(1),
    old: Quote.optional(),
    new: Quote.optional(),
    escape_hatch: z.string().min(1).optional(),
    grep: z.array(z.string().min(1)).min(1),
    upstream: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    pr: z.number().int().positive().nullable(),
    advisory: z
      .string()
      .regex(/^(GHSA-[a-z0-9-]+|CVE-\d{4}-\d+|https:\/\/\S+)$/)
      .nullable(),
  })
  .refine((change) => change.old !== undefined || change.new !== undefined, {
    message: "a change quotes at least one of `old` / `new`",
  });

export const BunReleaseManifestSchema = z.strictObject({
  schema: z.literal("bun-release-changes/1"),
  release: z.strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    tag: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    published: z.string().min(1),
  }),
  source: z.strictObject({
    doc: z.string().regex(/^[\w.-]+\.md$/),
    url: z.url(),
    fetched: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    classification: z.enum(["derived", "reviewed"]),
    pr_source: z.string().min(1),
  }),
  grep_exclude: z.array(z.string().min(1)),
  changes: z.array(ChangeSchema).min(1),
});

export type BunReleaseManifest = z.infer<typeof BunReleaseManifestSchema>;
export type BunReleaseChange = BunReleaseManifest["changes"][number];

export function parseBunReleaseManifest(yamlText: string): BunReleaseManifest {
  return BunReleaseManifestSchema.parse(Bun.YAML.parse(yamlText));
}

export function quotes(
  value: string | readonly string[] | undefined,
): string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Checks the manifest against its vendored doc. Returns one message per problem; an empty list
 * means every quote is verbatim, every section is a heading, every cited commit is in the doc,
 * every grep compiles and the doc bytes match the pinned sha256.
 */
export function validateBunReleaseManifest(
  manifest: BunReleaseManifest,
  docBytes: Uint8Array,
): string[] {
  const problems: string[] = [];
  const doc = new TextDecoder().decode(docBytes);
  const headings = new Set(
    doc.split("\n").filter((line) => /^#{1,6} /.test(line)),
  );
  const versionDigits = manifest.release.version.replaceAll(".", "");

  const actualSha = sha256Hex(docBytes);
  if (actualSha !== manifest.source.sha256) {
    problems.push(
      `source.sha256 is ${manifest.source.sha256} but ${manifest.source.doc} hashes to ${actualSha}; re-vendor the doc or update the pin`,
    );
  }
  if (manifest.source.doc !== `${manifest.release.version}.md`) {
    problems.push(
      `source.doc must be ${manifest.release.version}.md, found ${manifest.source.doc}`,
    );
  }

  const seen = new Set<string>();
  for (const change of manifest.changes) {
    const label = change.id;
    if (seen.has(change.id)) problems.push(`${label}: duplicate id`);
    seen.add(change.id);

    const [prefix, code] = change.id.split("-");
    if (prefix !== `BUN${versionDigits}`) {
      problems.push(`${label}: id prefix must be BUN${versionDigits}`);
    }
    if (code !== KIND_CODE[change.kind]) {
      problems.push(
        `${label}: kind ${change.kind} needs the ${KIND_CODE[change.kind]} code`,
      );
    }
    if (!headings.has(change.section)) {
      problems.push(
        `${label}: section ${JSON.stringify(change.section)} is not a heading in ${manifest.source.doc}`,
      );
    }
    for (const field of ["old", "new", "escape_hatch"] as const) {
      for (const quote of quotes(change[field])) {
        if (!doc.includes(quote)) {
          problems.push(
            `${label}: ${field} is not a verbatim quote of ${manifest.source.doc}: ${JSON.stringify(quote)}`,
          );
        }
      }
    }
    for (const pattern of change.grep) {
      try {
        new RegExp(pattern);
      } catch (error) {
        problems.push(
          `${label}: grep ${JSON.stringify(pattern)} does not compile: ${(error as Error).message}`,
        );
      }
    }
    if (
      change.upstream !== null &&
      !doc.includes(`commit/${change.upstream}`)
    ) {
      problems.push(
        `${label}: upstream ${change.upstream} is not a commit the doc cites`,
      );
    }
    if (change.pr !== null && change.upstream === null) {
      problems.push(
        `${label}: pr is resolved from the upstream commit, so it needs one`,
      );
    }
  }
  return problems;
}

function inlineCode(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function renderQuoteBlock(label: string, values: readonly string[]): string[] {
  if (values.length === 0) return [];
  return [`- ${label}:`, ...values.map((value) => `  > ${value}`)];
}

function link(change: BunReleaseChange): string {
  const upstream =
    change.upstream === null
      ? "MISSING"
      : `[${change.upstream.slice(0, 8)}](https://github.com/oven-sh/bun/commit/${change.upstream})`;
  const pr =
    change.pr === null
      ? "MISSING"
      : `[#${change.pr}](https://github.com/oven-sh/bun/pull/${change.pr})`;
  const advisory = change.advisory ?? "MISSING";
  return `- Upstream: ${upstream} · PR: ${pr} · Advisory: ${advisory}`;
}

/** Breaking, deprecation and security entries only, in that review order. */
export function renderBunReleaseDigest(manifest: BunReleaseManifest): string {
  const { version } = manifest.release;
  const order: readonly ChangeKind[] = ["security", "breaking", "deprecation"];
  const out: string[] = [
    `# Bun ${version} digest: security, breaking and deprecation changes`,
    "",
    `Generated from \`${version}.changes.yaml\` by \`bun run bun:release digest ${version}\`; do not edit by hand.`,
    `Source: <${manifest.source.url}> (sha256 \`${manifest.source.sha256}\`, fetched ${manifest.source.fetched}), release commit \`${manifest.release.commit}\`.`,
    `Classification: \`${manifest.source.classification}\`.`,
    "",
    "| Kind | Changes |",
    "| ---- | ------: |",
  ];
  for (const kind of order) {
    const count = manifest.changes.filter((c) => c.kind === kind).length;
    out.push(`| ${kind} | ${count} |`);
  }
  for (const kind of order) {
    const changes = manifest.changes.filter((c) => c.kind === kind);
    out.push("", `## ${kind[0]!.toUpperCase()}${kind.slice(1)}`);
    if (changes.length === 0) {
      out.push("", `None in ${version}.md.`);
      continue;
    }
    for (const change of changes) {
      out.push(
        "",
        `### ${change.id} ${change.slug}`,
        "",
        `- Section: ${inlineCode(change.section)}`,
        `- Surface: ${change.surface.join(", ")}`,
        ...renderQuoteBlock("Old", quotes(change.old)),
        ...renderQuoteBlock("New", quotes(change.new)),
        ...renderQuoteBlock("Escape hatch", quotes(change.escape_hatch)),
        link(change),
      );
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export type SurfaceHit = {
  readonly path: string;
  readonly line: number;
  readonly pattern: string;
  readonly text: string;
};

export type SurfaceScan = {
  readonly id: string;
  readonly kind: ChangeKind;
  readonly slug: string;
  readonly hits: readonly SurfaceHit[];
};

export type ScannedFile = { readonly path: string; readonly text: string };

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export function isScannable(
  path: string,
  excludes: readonly string[],
  text: string,
): boolean {
  if (text.length > MAX_SCAN_BYTES || text.includes("\0")) return false;
  return !excludes.some((pattern) => new Bun.Glob(pattern).match(path));
}

/** Runs every change's grep patterns line by line over `files`. */
export function scanBunReleaseSurfaces(
  manifest: BunReleaseManifest,
  files: readonly ScannedFile[],
  kinds: readonly ChangeKind[] = AUDIT_KINDS,
): SurfaceScan[] {
  const scannable = files.filter((file) =>
    isScannable(file.path, manifest.grep_exclude, file.text),
  );
  const split = scannable.map((file) => ({
    path: file.path,
    lines: file.text.split("\n"),
  }));
  return manifest.changes
    .filter((change) => kinds.includes(change.kind))
    .map((change) => {
      const hits: SurfaceHit[] = [];
      for (const pattern of change.grep) {
        const regex = new RegExp(pattern);
        for (const file of split) {
          file.lines.forEach((text, index) => {
            if (regex.test(text)) {
              hits.push({
                path: file.path,
                line: index + 1,
                pattern,
                text: text.trim().slice(0, 200),
              });
            }
          });
        }
      }
      return { id: change.id, kind: change.kind, slug: change.slug, hits };
    });
}
