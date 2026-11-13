#!/usr/bin/env bun
/**
 * @file scripts/bun_release_vendor.ts
 * @description Vendor and audit Bun release notes under docs/vendor/bun/.
 *
 *   bun run bun:release fetch 1.4.5            # download the blog markdown, print sha256 + cited commits
 *   bun run bun:release check 1.4.4            # manifest vs doc: verbatim quotes, sections, sha256
 *   bun run bun:release digest 1.4.4 [--check] # (re)write or verify <version>.digest.md
 *   bun run bun:release grep 1.4.4 [--json] [--id BUN144-BRK-001] [--kind fix]
 *
 * `grep` scans `git ls-files` with each change's patterns. It reports hits, not verdicts: the
 * audit prompt (docs/vendor/bun/AUDIT_PROMPT.md) classifies them.
 */

import { parseArgs } from "node:util";
import {
  AUDIT_KINDS,
  BUN_VENDOR_DIR,
  CHANGE_KINDS,
  type ChangeKind,
  parseBunReleaseManifest,
  renderBunReleaseDigest,
  scanBunReleaseSurfaces,
  sha256Hex,
  validateBunReleaseManifest,
} from "../lib/bun_release_manifest.ts";

const USAGE = `usage: bun run bun:release <fetch|check|digest|grep> <version> [options]

  fetch <version>             write ${BUN_VENDOR_DIR}/<version>.md from https://bun.com/blog/bun-v<version>.md
  check <version>             validate <version>.changes.yaml against <version>.md
  digest <version> [--check]  write <version>.digest.md, or exit 1 when it is stale
  grep <version> [--json] [--id ID]... [--kind KIND]...
                              scan tracked files with each change's grep patterns
                              (default kinds: ${AUDIT_KINDS.join(", ")})`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    check: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    id: { type: "string", multiple: true },
    kind: { type: "string", multiple: true },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, version] = positionals;
if (values.help || command === undefined || version === undefined) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `bun:release: version must look like 1.4.4, got ${JSON.stringify(version)}`,
  );
  process.exit(2);
}

const docPath = `${BUN_VENDOR_DIR}/${version}.md`;
const manifestPath = `${BUN_VENDOR_DIR}/${version}.changes.yaml`;
const digestPath = `${BUN_VENDOR_DIR}/${version}.digest.md`;

async function loadManifest() {
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) {
    console.error(
      `bun:release: ${manifestPath} is missing; write it from ${docPath} (see ${BUN_VENDOR_DIR}/README.md)`,
    );
    process.exit(2);
  }
  return parseBunReleaseManifest(await file.text());
}

async function trackedFiles(): Promise<{ path: string; text: string }[]> {
  const proc = Bun.spawn(["git", "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ls-files exited ${code}: ${err.trim()}`);
  const paths = out.split("\0").filter((path) => path !== "");
  return Promise.all(
    paths.map(async (path) => {
      const file = Bun.file(path);
      return { path, text: (await file.exists()) ? await file.text() : "" };
    }),
  );
}

switch (command) {
  case "fetch": {
    const url = `https://bun.com/blog/bun-v${version}.md`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`bun:release: GET ${url} returned ${response.status}`);
      process.exit(1);
    }
    const bytes = await response.bytes();
    await Bun.write(docPath, bytes);
    const text = new TextDecoder().decode(bytes);
    const commits = [...new Set(text.match(/commit\/[0-9a-f]{40}/g) ?? [])].map(
      (m) => m.slice(7),
    );
    console.log(`wrote ${docPath} (${bytes.byteLength} bytes)`);
    console.log(`sha256 ${sha256Hex(bytes)}`);
    console.log(`fetched ${new Date().toISOString().slice(0, 10)}`);
    console.log(
      `cited commits (${commits.length}); resolve PRs with gh api repos/oven-sh/bun/commits/<sha>/pulls:`,
    );
    for (const commit of commits) console.log(`  ${commit}`);
    break;
  }
  case "check": {
    const manifest = await loadManifest();
    const problems = validateBunReleaseManifest(
      manifest,
      await Bun.file(docPath).bytes(),
    );
    for (const problem of problems) console.error(`bun:release: ${problem}`);
    console.error(
      problems.length === 0
        ? `bun:release: OK · ${manifestPath} (${manifest.changes.length} changes)`
        : `bun:release: ${problems.length} problem(s)`,
    );
    process.exit(problems.length === 0 ? 0 : 1);
  }
  case "digest": {
    const rendered = renderBunReleaseDigest(await loadManifest());
    if (values.check) {
      const current = (await Bun.file(digestPath).exists())
        ? await Bun.file(digestPath).text()
        : "";
      if (current !== rendered) {
        console.error(
          `bun:release: ${digestPath} is stale; run bun run bun:release digest ${version}`,
        );
        process.exit(1);
      }
      console.error(`bun:release: OK · ${digestPath}`);
      break;
    }
    await Bun.write(digestPath, rendered);
    console.error(`bun:release: wrote ${digestPath}`);
    break;
  }
  case "grep": {
    const manifest = await loadManifest();
    const unknownKind = (values.kind ?? []).find(
      (kind) => !(CHANGE_KINDS as readonly string[]).includes(kind),
    );
    if (unknownKind !== undefined) {
      console.error(
        `bun:release: unknown --kind ${unknownKind}; expected one of ${CHANGE_KINDS.join(", ")}`,
      );
      process.exit(2);
    }
    const kinds =
      values.kind === undefined ? AUDIT_KINDS : (values.kind as ChangeKind[]);
    const scans = scanBunReleaseSurfaces(
      manifest,
      await trackedFiles(),
      kinds,
    ).filter((scan) => values.id === undefined || values.id.includes(scan.id));
    if (values.json) {
      console.log(JSON.stringify(scans, null, 2));
      break;
    }
    for (const scan of scans) {
      console.log(
        `${scan.id} ${scan.slug} (${scan.kind}): ${scan.hits.length} hit(s)`,
      );
      for (const hit of scan.hits.slice(0, 25)) {
        console.log(`  ${hit.path}:${hit.line}  ${hit.text}`);
      }
      if (scan.hits.length > 25)
        console.log(`  … ${scan.hits.length - 25} more (--json for all)`);
    }
    break;
  }
  default:
    console.error(
      `bun:release: unknown command ${JSON.stringify(command)}\n${USAGE}`,
    );
    process.exit(2);
}
