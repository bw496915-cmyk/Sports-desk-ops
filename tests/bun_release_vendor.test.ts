/**
 * @file tests/bun_release_vendor.test.ts
 * @description Contract for vendored Bun release notes (docs/vendor/bun/): each manifest quotes its
 * pinned doc verbatim and its digest is the rendered manifest.
 */

import { describe, expect, test } from "bun:test";
import {
  BUN_VENDOR_DIR,
  type BunReleaseManifest,
  parseBunReleaseManifest,
  renderBunReleaseDigest,
  scanBunReleaseSurfaces,
  validateBunReleaseManifest,
} from "../lib/bun_release_manifest.ts";

const manifestPaths = [
  ...new Bun.Glob(`${BUN_VENDOR_DIR}/*.changes.yaml`).scanSync("."),
].sort();

async function load(path: string) {
  const manifest = parseBunReleaseManifest(await Bun.file(path).text());
  const docBytes = await Bun.file(
    `${BUN_VENDOR_DIR}/${manifest.source.doc}`,
  ).bytes();
  return { manifest, docBytes };
}

test("at least one Bun release is vendored", () => {
  expect(manifestPaths.length).toBeGreaterThan(0);
});

describe.each(manifestPaths)("%s", (path) => {
  test("quotes its pinned doc verbatim", async () => {
    const { manifest, docBytes } = await load(path);
    expect(validateBunReleaseManifest(manifest, docBytes)).toEqual([]);
  });

  test("is named after its release version", async () => {
    const { manifest } = await load(path);
    expect(path).toBe(
      `${BUN_VENDOR_DIR}/${manifest.release.version}.changes.yaml`,
    );
  });

  test("digest is the rendered manifest", async () => {
    const { manifest } = await load(path);
    const digest = await Bun.file(
      `${BUN_VENDOR_DIR}/${manifest.release.version}.digest.md`,
    ).text();
    expect(digest).toBe(renderBunReleaseDigest(manifest));
  });
});

describe("validateBunReleaseManifest", () => {
  const doc = new TextEncoder().encode(
    "# Bun v9.9.9\n\n### `thing` changes\n\nIt used to return 1. Now it returns 2.\n<!-- https://github.com/oven-sh/bun/commit/0123456789abcdef0123456789abcdef01234567 -->\n",
  );
  const sha = new Bun.CryptoHasher("sha256").update(doc).digest("hex");
  const base = (): BunReleaseManifest =>
    parseBunReleaseManifest(
      Bun.YAML.stringify({
        schema: "bun-release-changes/1",
        release: {
          version: "9.9.9",
          tag: "bun-v9.9.9",
          commit: "f".repeat(40),
          published: "2030-01-01T00:00:00Z",
        },
        source: {
          doc: "9.9.9.md",
          url: "https://bun.com/blog/bun-v9.9.9.md",
          fetched: "2030-01-02",
          sha256: sha,
          classification: "derived",
          pr_source: "github-commit-pulls",
        },
        grep_exclude: ["vendor/**"],
        changes: [
          {
            id: "BUN999-BRK-001",
            slug: "thing-returns-two",
            kind: "breaking",
            section: "### `thing` changes",
            surface: ["thing"],
            old: "It used to return 1.",
            new: "Now it returns 2.",
            grep: ["\\bthing\\("],
            upstream: "0123456789abcdef0123456789abcdef01234567",
            pr: 1,
            advisory: null,
          },
        ],
      }),
    );

  test("accepts verbatim quotes", () => {
    expect(validateBunReleaseManifest(base(), doc)).toEqual([]);
  });

  test("rejects a paraphrased quote", () => {
    const manifest = base();
    manifest.changes[0]!.new = "It returns 2 now.";
    expect(validateBunReleaseManifest(manifest, doc)).toEqual([
      'BUN999-BRK-001: new is not a verbatim quote of 9.9.9.md: "It returns 2 now."',
    ]);
  });

  test("rejects a doc whose bytes moved", () => {
    const edited = new TextEncoder().encode(
      `${new TextDecoder().decode(doc)}\n`,
    );
    const problems = validateBunReleaseManifest(base(), edited);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("source.sha256 is ");
  });

  test("rejects an id whose code disagrees with its kind", () => {
    const manifest = base();
    manifest.changes[0]!.kind = "security";
    expect(validateBunReleaseManifest(manifest, doc)).toContain(
      "BUN999-BRK-001: kind security needs the SEC code",
    );
  });

  test("rejects a section that is not a heading and an uncited commit", () => {
    const manifest = base();
    manifest.changes[0]!.section = "### thing changes";
    manifest.changes[0]!.upstream = "a".repeat(40);
    expect(validateBunReleaseManifest(manifest, doc)).toEqual([
      'BUN999-BRK-001: section "### thing changes" is not a heading in 9.9.9.md',
      `BUN999-BRK-001: upstream ${"a".repeat(40)} is not a commit the doc cites`,
    ]);
  });

  test("schema rejects an id code no kind owns and a malformed version", () => {
    const manifest = base();
    expect(() =>
      parseBunReleaseManifest(
        Bun.YAML.stringify({
          ...manifest,
          changes: [{ ...manifest.changes[0], id: "BUN999-XYZ-001" }],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseBunReleaseManifest(
        Bun.YAML.stringify({
          ...manifest,
          release: { ...manifest.release, version: "1.4" },
        }),
      ),
    ).toThrow("version must look like 1.4.4");
  });

  test("schema rejects a change without old or new", () => {
    expect(() =>
      parseBunReleaseManifest(
        Bun.YAML.stringify({
          ...base(),
          changes: [{ ...base().changes[0], old: undefined, new: undefined }],
        }),
      ),
    ).toThrow("a change quotes at least one of `old` / `new`");
  });

  test("scan reports hits per change and skips excluded or binary files", () => {
    const [scan] = scanBunReleaseSurfaces(base(), [
      { path: "src/a.ts", text: "const x = 1;\nthing(2);\n" },
      { path: "vendor/b.ts", text: "thing(3);\n" },
      { path: "src/c.bin", text: "thing(4);\0" },
    ]);
    expect(scan?.hits).toEqual([
      {
        path: "src/a.ts",
        line: 2,
        pattern: "\\bthing\\(",
        text: "thing(2);",
      },
    ]);
  });

  test("scan leaves out kinds an audit did not opt into", () => {
    const manifest = base();
    manifest.changes[0]!.kind = "fix";
    manifest.changes[0]!.id = "BUN999-FIX-001";
    expect(scanBunReleaseSurfaces(manifest, [])).toEqual([]);
    expect(scanBunReleaseSurfaces(manifest, [], ["fix"])).toHaveLength(1);
  });
});
