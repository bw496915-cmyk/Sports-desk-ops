/**
 * @file lib/screenshot_encode.ts
 * @description Re-encode WebView screenshots with Bun.Image.
 *
 * The WebKit backend can only produce png/jpeg, so webp and resizing are done after the fact rather
 * than by forcing the Chrome backend. `Bun.Image` is mutable: `resize()` and `webp()` return the same
 * instance, so the order of operations is visible in the chain below.
 *
 * Canonical Bun.Image contract (`docs/runtime/image.mdx` & `bun.d.ts`):
 * - `new Bun.Image(input, { maxPixels, autoOrient })` guards against decompression bombs before
 *   allocating the pixel buffer.
 * - `resize(width, height, { fit, withoutEnlargement, filter })` supports `"inside"` aspect-preserving
 *   fit, `withoutEnlargement: true`, and resampling kernels (`"lanczos3"` default).
 * - `png({ compressionLevel, palette, colors, dither })` supports indexed palette PNGs (3-5x smaller
 *   for UI screenshots).
 * - `.bytes()` is the canonical `Promise<Uint8Array>` terminal (`.toBuffer()` is a Sharp-compat alias).
 */

export type ScreenshotFormat = "png" | "jpeg" | "webp";

export interface ResizeSpec {
  readonly width: number;
  readonly height?: number;
  readonly fit?: Bun.Image.ResizeOptions["fit"];
  readonly withoutEnlargement?: boolean;
  readonly filter?: Bun.Image.Filter;
}

export interface EncodeOptions {
  readonly format: ScreenshotFormat;
  /** 1-100; ignored for png. */
  readonly quality?: number;
  /** Emit a progressive JPEG (default false). */
  readonly progressive?: boolean;
  /** Emit a lossless WebP (default false). */
  readonly lossless?: boolean;
  /** Quantize PNG to a <=256-color indexed palette (3-5x smaller for UI screenshots). */
  readonly palette?: boolean;
  readonly resize?: ResizeSpec;
  /** Maximum allowed source/target pixel count (`width * height`, default 16384 * 16384). */
  readonly maxPixels?: number;
}

const DEFAULT_MAX_PIXELS = 16_384 * 16_384;

const MAGIC: Record<ScreenshotFormat, readonly number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpeg: [0xff, 0xd8, 0xff],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF; "WEBP" follows at offset 8
};

export function looksLike(
  format: ScreenshotFormat,
  bytes: Uint8Array,
): boolean {
  const magic = MAGIC[format];
  if (!magic.every((byte, index) => bytes[index] === byte)) return false;
  if (format === "webp") {
    return (
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  return true;
}

/** Read `width`, `height`, and `format` from the image header without decoding pixels. */
export async function readImageMetadata(
  input: Uint8Array | ArrayBuffer | Blob,
  maxPixels: number = DEFAULT_MAX_PIXELS,
): Promise<Bun.Image.Metadata> {
  return new Bun.Image(input, { maxPixels }).metadata();
}

export async function encodeScreenshot(
  png: Uint8Array,
  options: EncodeOptions,
): Promise<Uint8Array> {
  if (png.byteLength === 0) throw new Error("screenshot is empty");
  const image = new Bun.Image(png, {
    maxPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
    autoOrient: true,
  });

  if (options.resize !== undefined) {
    const { width, height, fit, withoutEnlargement, filter } = options.resize;
    if (!Number.isInteger(width) || width < 1 || width > 16384) {
      throw new Error(`resize width out of range: ${width}`);
    }
    const resizeOptions: Bun.Image.ResizeOptions = {
      ...(fit === undefined ? {} : { fit }),
      ...(withoutEnlargement === undefined ? {} : { withoutEnlargement }),
      ...(filter === undefined ? {} : { filter }),
    };
    const hasResizeOptions = Object.keys(resizeOptions).length > 0;
    if (height === undefined) {
      if (hasResizeOptions) image.resize(width, undefined, resizeOptions);
      else image.resize(width);
    } else {
      if (!Number.isInteger(height) || height < 1 || height > 16384) {
        throw new Error(`resize height out of range: ${height}`);
      }
      if (hasResizeOptions) image.resize(width, height, resizeOptions);
      else image.resize(width, height);
    }
  }

  const quality = options.quality ?? 80;
  const encoded =
    options.format === "png"
      ? options.palette === true
        ? image.png({ palette: true, dither: true })
        : image.png()
      : options.format === "jpeg"
        ? image.jpeg({
            quality,
            ...(options.progressive === undefined
              ? {}
              : { progressive: options.progressive }),
          })
        : image.webp({
            quality,
            ...(options.lossless === undefined
              ? {}
              : { lossless: options.lossless }),
          });

  // `.bytes()` is the canonical Uint8Array terminal in Bun.Image (`docs/runtime/image.mdx`);
  // fall back to `.toBuffer()` if a test stub only implements the Sharp alias.
  const bytes =
    typeof encoded.bytes === "function"
      ? await encoded.bytes()
      : new Uint8Array(await encoded.toBuffer());
  if (!looksLike(options.format, bytes)) {
    throw new Error(
      `encoder produced ${options.format} bytes with the wrong magic`,
    );
  }
  return bytes;
}

/** Parse `WxH` or `W` from a CLI flag. */
export function parseResize(spec: string): { width: number; height?: number } {
  const match = /^(\d+)(?:x(\d+))?$/.exec(spec.trim());
  if (match === null)
    throw new Error(`--resize expects WxH or W (got "${spec}")`);
  const width = Number(match[1]);
  const height = match[2] === undefined ? undefined : Number(match[2]);
  return height === undefined ? { width } : { width, height };
}
