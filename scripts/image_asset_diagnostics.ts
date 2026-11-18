#!/usr/bin/env bun
/**
 * @file scripts/image_asset_diagnostics.ts
 * @description Print `Bun.Image` asset attributes and optionally write deterministic WebP thumbnails.
 *
 * Metadata reads the header only, so the default scan does not decode pixels; `--placeholders`
 * opts into the ThumbHash decode and `--thumbs` opts into a resize + WebP encode. Entry and
 * thumbnail paths are masked per the selected visibility tier. Exit 1 when a file is oversized,
 * undecodable, or a thumbnail cannot be written, so the command can gate a build.
 *
 * Run: bun run assets:diagnostics [dir ...] [options]   (see --help)
 */

import { useColor } from "../lib/ansi_color.ts";
import { join } from "node:path";
import {
  scanBunImageAssetFiles,
  type BunImageAssetFile,
} from "../lib/bun_image_assets.ts";
import {
  thumbnailDestination,
  writeWebpThumbnail,
  type BunImageBackend,
} from "../lib/bun_thumbnail.ts";
import {
  INSPECT_VISIBILITIES,
  type InspectVisibility,
} from "../lib/inspect_redactor.ts";
import { maskAssetSource } from "../lib/inspect_diagnostics.ts";

const DEFAULT_ROOT = "docs/assets";
const TOOL_VERSION = "1.3.0";
const VISIBILITY_NAMES = new Set<string>(INSPECT_VISIBILITIES);
const SORT_MODES = ["name", "size"] as const;
type SortMode = (typeof SORT_MODES)[number];
const BACKEND_MODES = ["bun", "system"] as const;
const MAX_THUMB_EDGE = 16_384;

const USAGE = `image_asset_diagnostics ${TOOL_VERSION} — Bun.Image asset attributes

Usage:
  bun run assets:diagnostics [dir ...] [options]

Directories default to ${DEFAULT_ROOT}. Each directory is scanned shallowly unless --recursive.

Options:
  --json                  Machine output (single JSON object, full entries)
  --summary               Text totals per directory; skip per-asset cards
  --limit=N               Entries per directory, clamped to 1..100 (default 24)
  --recursive, -r         Walk subdirectories with a Bun.Glob (**/*.{png,jpg,…})
  --filter=TEXT           Case-insensitive substring filter on the relative asset name
  --sort=name|size        name (default, scan order) or size (largest first)
  --placeholders          Decode each image to compute its ThumbHash placeholder (slower)
  --max-bytes=N           Skip files larger than N bytes (default 8 MiB)
  --header-bytes=N        Read only N bytes per file and resolve dimensions from the header
  --visibility=TIER       ${INSPECT_VISIBILITIES.join(" | ")}
  --backend=bun|system    Set Bun.Image.backend before reading (default: runtime value)
  --thumbs[=EDGE]         Write WebP thumbnails capped at EDGE px (default 400)
  --thumbs-dir=DIR        Thumbnail directory (default: <dir>/.thumbs)
  --thumb-quality=N       WebP quality 1..100 (default 80)
  --no-fail               Exit 0 even when an asset or thumbnail fails
  --no-color              Disable ANSI color
  --version, -v           Print the tool and Bun versions
  -h, --help              Show this help

Thumbnails use \`Bun.Image.backend = "bun"\` unless --backend says otherwise, so resize geometry is
portable; JPEG/PNG/WebP codecs are byte-identical across platforms, while TIFF/HEIC/AVIF still
decode through the OS. Hidden \`.thumbs\` directories are skipped by --recursive (Bun.Glob default).

Exit codes: 0 all files readable · 1 any scan or thumbnail failure · 2 invalid argument

Examples:
  bun run assets:diagnostics
  bun run assets:diagnostics docs/assets --recursive --filter=pipeline --limit=10
  bun run assets:diagnostics --json --sort=size --placeholders > /tmp/assets.json
  bun run assets:diagnostics --header-bytes=65536 --recursive
  bun run assets:diagnostics --thumbs=320 --recursive --summary
  bun run assets:diagnostics docs/assets --thumbs --thumbs-dir=scratch/thumbs`;

interface ParsedArgs {
  readonly dirs: readonly string[];
  readonly json: boolean;
  readonly summary: boolean;
  readonly limit: number | undefined;
  readonly maxBytes: number | undefined;
  readonly headerBytes: number | undefined;
  readonly recursive: boolean;
  readonly filter: string | undefined;
  readonly sort: SortMode;
  readonly placeholders: boolean;
  readonly visibility: InspectVisibility;
  readonly backend: BunImageBackend | undefined;
  readonly thumbs: number | null;
  readonly thumbsDir: string | undefined;
  readonly thumbQuality: number;
  readonly fail: boolean;
  readonly color: boolean;
}

interface ThumbnailWritten {
  readonly ok: true;
  readonly source: string;
  readonly destination: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly backend: string;
}

interface ThumbnailFailed {
  readonly ok: false;
  readonly source: string;
  readonly error: string;
}

type ThumbnailOutcome = ThumbnailWritten | ThumbnailFailed;

interface DirectoryReport {
  readonly root: string;
  readonly total: number;
  readonly truncated: boolean;
  readonly failures: number;
  readonly files: readonly BunImageAssetFile[];
  readonly thumbnails: readonly ThumbnailOutcome[];
  readonly thumbnailFailures: number;
}

function isVisibility(value: string): value is InspectVisibility {
  return VISIBILITY_NAMES.has(value);
}

function isSortMode(value: string): value is SortMode {
  return (SORT_MODES as readonly string[]).includes(value);
}

function isBackend(value: string): value is BunImageBackend {
  return (BACKEND_MODES as readonly string[]).includes(value);
}

function intInRange(
  name: string,
  raw: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer in ${minimum}..${maximum}, got "${raw}"`,
    );
  }
  return value;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const dirs: string[] = [];
  let json = false;
  let summary = false;
  let limit: number | undefined;
  let maxBytes: number | undefined;
  let headerBytes: number | undefined;
  let recursive = false;
  let filter: string | undefined;
  let sort: SortMode = "name";
  let placeholders = false;
  let visibility: InspectVisibility = "RISK_MANAGER";
  let backend: BunImageBackend | undefined;
  let thumbs: number | null = null;
  let thumbsDir: string | undefined;
  let thumbQuality = 80;
  let thumbQualitySet = false;
  let fail = true;
  let color = true;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      continue; // handled before parsing
    } else if (arg === "-v" || arg === "--version") {
      continue; // handled before parsing
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--summary") {
      summary = true;
    } else if (arg === "--recursive" || arg === "-r") {
      recursive = true;
    } else if (arg === "--placeholders") {
      placeholders = true;
    } else if (arg === "--no-fail") {
      fail = false;
    } else if (arg === "--no-color") {
      color = false;
    } else if (arg === "--thumbs") {
      thumbs = 400;
    } else if (arg.startsWith("--thumbs=")) {
      thumbs = intInRange(
        "--thumbs",
        arg.slice("--thumbs=".length),
        1,
        MAX_THUMB_EDGE,
      );
    } else if (arg.startsWith("--thumbs-dir=")) {
      const value = arg.slice("--thumbs-dir=".length).trim();
      if (value === "") throw new Error("--thumbs-dir must not be empty");
      thumbsDir = value;
    } else if (arg.startsWith("--thumb-quality=")) {
      thumbQuality = intInRange(
        "--thumb-quality",
        arg.slice("--thumb-quality=".length),
        1,
        100,
      );
      thumbQualitySet = true;
    } else if (arg.startsWith("--limit=")) {
      limit = intInRange("--limit", arg.slice("--limit=".length), 1, 100);
    } else if (arg.startsWith("--max-bytes=")) {
      maxBytes = intInRange(
        "--max-bytes",
        arg.slice("--max-bytes=".length),
        1,
        Number.MAX_SAFE_INTEGER,
      );
    } else if (arg.startsWith("--header-bytes=")) {
      headerBytes = intInRange(
        "--header-bytes",
        arg.slice("--header-bytes=".length),
        1,
        Number.MAX_SAFE_INTEGER,
      );
    } else if (arg.startsWith("--filter=")) {
      const value = arg.slice("--filter=".length).trim();
      filter = value === "" ? undefined : value;
    } else if (arg.startsWith("--sort=")) {
      const value = arg.slice("--sort=".length);
      if (!isSortMode(value)) {
        throw new Error(
          `--sort must be one of ${SORT_MODES.join(", ")}, got "${value}"`,
        );
      }
      sort = value;
    } else if (arg.startsWith("--visibility=")) {
      const value = arg.slice("--visibility=".length);
      if (!isVisibility(value)) {
        throw new Error(
          `--visibility must be one of ${INSPECT_VISIBILITIES.join(", ")}, got "${value}"`,
        );
      }
      visibility = value;
    } else if (arg.startsWith("--backend=")) {
      const value = arg.slice("--backend=".length);
      if (!isBackend(value)) {
        throw new Error(
          `--backend must be one of ${BACKEND_MODES.join(", ")}, got "${value}"`,
        );
      }
      backend = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option "${arg}"`);
    } else {
      dirs.push(arg);
    }
  }

  if (thumbsDir !== undefined && thumbs === null) {
    throw new Error("--thumbs-dir requires --thumbs");
  }
  if (thumbQualitySet && thumbs === null) {
    throw new Error("--thumb-quality requires --thumbs");
  }
  if (headerBytes !== undefined && placeholders) {
    throw new Error("--header-bytes cannot be combined with --placeholders");
  }

  return {
    dirs: dirs.length === 0 ? [DEFAULT_ROOT] : dirs,
    json,
    summary,
    limit,
    maxBytes,
    headerBytes,
    recursive,
    filter,
    sort,
    placeholders,
    visibility,
    backend,
    thumbs,
    thumbsDir,
    thumbQuality,
    fail,
    color,
  };
}

function bytesOf(file: BunImageAssetFile): number {
  return file.entry.type === "BunImageAssetScanFailure"
    ? 0
    : (file.entry.bytes ?? 0);
}

/** Error codes only: a raw message can quote the absolute destination path. */
function errorCodeOf(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "ERR_THUMBNAIL_WRITE";
}

async function buildReport(
  root: string,
  args: ParsedArgs,
): Promise<DirectoryReport> {
  // A size sort must see every candidate before the requested limit is applied.
  const scanLimit = args.sort === "size" ? 100 : args.limit;
  const scan = await scanBunImageAssetFiles(root, {
    limit: scanLimit,
    maxBytes: args.maxBytes,
    headerBytes: args.headerBytes,
    visibility: args.visibility,
    recursive: args.recursive,
    filter: args.filter,
    placeholders: args.placeholders,
  });
  const ordered =
    args.sort === "size"
      ? [...scan.files].sort((a, b) => bytesOf(b) - bytesOf(a))
      : scan.files;
  const files =
    args.limit === undefined ? ordered : ordered.slice(0, args.limit);

  let failures = 0;
  for (const file of files) {
    if (file.entry.type === "BunImageAssetScanFailure") failures += 1;
  }

  const thumbnails: ThumbnailOutcome[] = [];
  let thumbnailFailures = 0;
  if (args.thumbs !== null) {
    const thumbsDir = args.thumbsDir ?? join(root, ".thumbs");
    for (const file of files) {
      if (file.entry.type !== "BunImageAssetDiagnostic") continue;
      const destination = thumbnailDestination(root, file.path, thumbsDir);
      try {
        const thumb = await writeWebpThumbnail(file.path, destination, {
          maxEdge: args.thumbs,
          quality: args.thumbQuality,
          backend: args.backend ?? "bun",
        });
        thumbnails.push(
          Object.freeze({
            ok: true as const,
            source: file.path,
            destination,
            bytes: thumb.bytesWritten,
            width: thumb.width,
            height: thumb.height,
            backend: thumb.backend,
          }),
        );
      } catch (error) {
        thumbnailFailures += 1;
        thumbnails.push(
          Object.freeze({
            ok: false as const,
            source: file.path,
            error: errorCodeOf(error),
          }),
        );
      }
    }
  }

  return {
    root,
    total: scan.total,
    truncated: scan.total > files.length,
    failures,
    files,
    thumbnails,
    thumbnailFailures,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function printText(
  reports: readonly DirectoryReport[],
  args: ParsedArgs,
  color: boolean,
): void {
  for (const report of reports) {
    const suffix = report.truncated
      ? ` (showing ${report.files.length} of ${report.total})`
      : "";
    console.log(
      `Image assets · ${report.root} · ${report.files.length}${suffix} · visibility=${args.visibility}` +
        (args.headerBytes === undefined
          ? ""
          : ` · header≤${args.headerBytes} B`),
    );
    if (args.summary) {
      const thumbs =
        args.thumbs === null
          ? ""
          : ` · thumbnails=${report.thumbnails.length - report.thumbnailFailures}` +
            (report.thumbnailFailures > 0
              ? ` thumbFailures=${report.thumbnailFailures}`
              : "");
      console.log(
        `  total=${report.total} · failures=${report.failures} · shown=${report.files.length}${thumbs}`,
      );
      console.log("");
      continue;
    }
    for (const file of report.files) {
      console.log(Bun.inspect(file.entry, { colors: color, depth: 2 }));
      console.log("");
    }
    if (args.thumbs !== null && report.thumbnails.length > 0) {
      console.log("Thumbnails");
      for (const thumb of report.thumbnails) {
        const source = maskAssetSource(thumb.source, args.visibility);
        if (thumb.ok) {
          const destination = maskAssetSource(
            thumb.destination,
            args.visibility,
          );
          console.log(
            `  ${source} → ${destination} (${thumb.width}×${thumb.height}, ${formatBytes(thumb.bytes)})`,
          );
        } else {
          console.log(`  ${source} → failed: ${thumb.error}`);
        }
      }
      console.log("");
    }
  }
  const failures = reports.reduce(
    (sum, report) => sum + report.failures + report.thumbnailFailures,
    0,
  );
  if (failures > 0) {
    console.log(`${failures} asset(s) could not be decoded or thumbnailed.`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(`image_asset_diagnostics ${TOOL_VERSION} (Bun ${Bun.version})`);
    return 0;
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`image_asset_diagnostics: ${message}`);
    console.error(USAGE);
    return 2;
  }

  if (args.backend !== undefined) {
    Bun.Image.backend = args.backend;
  }

  const reports: DirectoryReport[] = [];
  for (const dir of args.dirs) {
    reports.push(await buildReport(dir, args));
  }
  const failures = reports.reduce(
    (sum, report) => sum + report.failures + report.thumbnailFailures,
    0,
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: failures === 0,
          generatedAt: new Date().toISOString(),
          visibility: args.visibility,
          backend: Bun.Image.backend,
          headerBytes: args.headerBytes ?? null,
          recursive: args.recursive,
          filter: args.filter ?? null,
          sort: args.sort,
          failures,
          thumbnails:
            args.thumbs === null
              ? { enabled: false }
              : {
                  enabled: true,
                  maxEdge: args.thumbs,
                  quality: args.thumbQuality,
                  backend: args.backend ?? "bun",
                },
          directories: reports.map((report) => ({
            root: report.root,
            total: report.total,
            truncated: report.truncated,
            count: report.files.length,
            assets: report.files.map((file) => file.entry),
            thumbnails: report.thumbnails.map((thumb) =>
              thumb.ok
                ? {
                    source: maskAssetSource(thumb.source, args.visibility),
                    path: maskAssetSource(thumb.destination, args.visibility),
                    bytes: thumb.bytes,
                    width: thumb.width,
                    height: thumb.height,
                    backend: thumb.backend,
                  }
                : {
                    source: maskAssetSource(thumb.source, args.visibility),
                    error: thumb.error,
                  },
            ),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    printText(
      reports,
      args,
      args.color &&
        useColor({ env: Bun.env, isTTY: process.stdout.isTTY === true }),
    );
  }

  if (failures > 0 && args.fail) return 1;
  return 0;
}

process.exit(await main(Bun.argv.slice(2)));
