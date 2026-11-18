/**
 * @file lib/bun_image_assets.ts
 * @description Bounded directory scan of raster assets into `BunImageAssetDiagnostic` entries.
 *
 * `Bun.Image.Metadata` reads only the header, so listing an asset directory does not decode pixels
 * and stays cheap enough for a dashboard request. Oversized and undecodable files become
 * `BunImageAssetScanFailure` entries instead of aborting the scan; the failure carries the
 * `Bun.Image.ErrorCode` and a masked source, never the raw error (which can quote file bytes).
 */

import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { imageErrorCode } from "./image_errors.ts";
import { readImageHeaderMetadata } from "./image_header.ts";
import {
  BunImageAssetDiagnostic,
  inspectBunImageAsset,
  maskAssetSource,
} from "./inspect_diagnostics.ts";
import type { InspectVisibility } from "./inspect_redactor.ts";

export const IMAGE_ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
]);

export interface ImageAssetScanOptions {
  /** Maximum entries returned, clamped to `1..100`. Default 24. */
  readonly limit?: number | undefined;
  /** Skip files larger than this many bytes. Default 8 MiB. */
  readonly maxBytes?: number | undefined;
  readonly visibility?: InspectVisibility | undefined;
  readonly maxPixels?: number | undefined;
  /** Walk subdirectories with a `Bun.Glob` instead of reading one level. */
  readonly recursive?: boolean | undefined;
  /** Case-insensitive substring filter on the relative asset name, applied before the limit. */
  readonly filter?: string | undefined;
  /** Decode each image to compute its ThumbHash placeholder (slower than header metadata). */
  readonly placeholders?: boolean | undefined;
  /**
   * Read only this many bytes per file and resolve dimensions with `readImageHeaderMetadata()`.
   * Truncated headers report `ERR_IMAGE_HEADER_TRUNCATED` plus the next prefix length. A JPEG whose
   * EXIF sits ahead of SOF may need the whole prefix budget; PNG/WebP need 24/32 bytes.
   */
  readonly headerBytes?: number | undefined;
}

/** Recursive-scan glob (brace list of `IMAGE_ASSET_EXTENSIONS` minus the leading dot). */
export const IMAGE_ASSET_GLOB = `**/*.{${[...IMAGE_ASSET_EXTENSIONS]
  .map((extension) => extension.slice(1))
  .join(",")}}`;

export interface BunImageAssetScanFailure {
  readonly type: "BunImageAssetScanFailure";
  readonly source: string;
  readonly code: string;
  /** Set for `ERR_IMAGE_HEADER_TRUNCATED`: the next prefix length to request. */
  readonly requiredBytes?: number | undefined;
}

export type BunImageAssetScanEntry =
  BunImageAssetDiagnostic | BunImageAssetScanFailure;

function failureFor(
  path: string,
  code: string,
  visibility: InspectVisibility | undefined,
  requiredBytes?: number | null,
): BunImageAssetScanFailure {
  return Object.freeze({
    type: "BunImageAssetScanFailure",
    source: maskAssetSource(path, visibility),
    code,
    ...(requiredBytes === undefined || requiredBytes === null
      ? {}
      : { requiredBytes }),
  });
}

export interface ImageAssetScanResult {
  readonly entries: readonly BunImageAssetScanEntry[];
  /** Raster files found before the limit was applied. */
  readonly total: number;
  readonly truncated: boolean;
}

/** One scanned asset with its real path, for callers that write beside it (thumbnails). */
export interface BunImageAssetFile {
  readonly path: string;
  readonly entry: BunImageAssetScanEntry;
}

export interface ImageAssetFileScanResult {
  readonly files: readonly BunImageAssetFile[];
  readonly total: number;
  readonly truncated: boolean;
}

/** Lists image attributes and real paths under one directory, shallow and name-sorted. */
export async function scanBunImageAssetFiles(
  dir: string,
  options: ImageAssetScanOptions = {},
): Promise<ImageAssetFileScanResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 24, 100));
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  let names: string[];
  try {
    if (options.recursive === true) {
      names = [
        ...new Bun.Glob(IMAGE_ASSET_GLOB).scanSync({
          cwd: dir,
          onlyFiles: true,
        }),
      ];
    } else {
      names = readdirSync(dir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            IMAGE_ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase()),
        )
        .map((entry) => entry.name);
    }
  } catch {
    return Object.freeze({
      files: Object.freeze([]),
      total: 0,
      truncated: false,
    });
  }

  const filter = options.filter?.trim().toLowerCase() ?? "";
  if (filter !== "") {
    names = names.filter((name) => name.toLowerCase().includes(filter));
  }
  names.sort();

  const selected = names.slice(0, limit);
  const files = await Promise.all(
    selected.map(async (name): Promise<BunImageAssetFile> => {
      const path = join(dir, name);
      const file = Bun.file(path);
      if (file.size > maxBytes) {
        return Object.freeze({
          path,
          entry: failureFor(path, "ERR_IMAGE_TOO_LARGE", options.visibility),
        });
      }
      if (options.headerBytes !== undefined) {
        try {
          const prefix = new Uint8Array(
            await file.slice(0, options.headerBytes).arrayBuffer(),
          );
          const header = await readImageHeaderMetadata(prefix);
          if (!header.ok) {
            return Object.freeze({
              path,
              entry: failureFor(
                path,
                header.code,
                options.visibility,
                header.requiredBytes,
              ),
            });
          }
          return Object.freeze({
            path,
            entry: new BunImageAssetDiagnostic({
              source: path,
              ...header.attributes,
              bytes: file.size,
              visibility: options.visibility,
            }),
          });
        } catch (error) {
          return Object.freeze({
            path,
            entry: failureFor(
              path,
              imageErrorCode(error) ?? "ERR_IMAGE_DECODE_FAILED",
              options.visibility,
            ),
          });
        }
      }
      try {
        return Object.freeze({
          path,
          entry: await inspectBunImageAsset(path, {
            displaySource: path,
            bytes: file.size,
            visibility: options.visibility,
            maxPixels: options.maxPixels,
            computePlaceholder: options.placeholders === true,
          }),
        });
      } catch (error) {
        return Object.freeze({
          path,
          entry: failureFor(
            path,
            imageErrorCode(error) ?? "ERR_IMAGE_DECODE_FAILED",
            options.visibility,
          ),
        });
      }
    }),
  );
  return Object.freeze({
    files: Object.freeze(files),
    total: names.length,
    truncated: names.length > selected.length,
  });
}

/** Lists image attributes under one directory, shallow and name-sorted. */
export async function scanBunImageAssetDirectory(
  dir: string,
  options: ImageAssetScanOptions = {},
): Promise<ImageAssetScanResult> {
  const scan = await scanBunImageAssetFiles(dir, options);
  return Object.freeze({
    entries: Object.freeze(scan.files.map((file) => file.entry)),
    total: scan.total,
    truncated: scan.truncated,
  });
}

/** Convenience wrapper for callers that only need the entries. */
export async function scanBunImageAssets(
  dir: string,
  options: ImageAssetScanOptions = {},
): Promise<readonly BunImageAssetScanEntry[]> {
  return (await scanBunImageAssetDirectory(dir, options)).entries;
}
