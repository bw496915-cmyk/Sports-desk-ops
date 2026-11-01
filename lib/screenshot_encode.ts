/**
 * @file lib/screenshot_encode.ts
 * @description Re-encode WebView screenshots with Bun.Image and canonical Blob/Base64/Shmem/ThumbHash helpers.
 *
 * The WebKit backend can only produce png/jpeg, so webp/avif/heic and resizing are done after the fact
 * rather than by forcing the Chrome backend. `Bun.Image` is mutable: `resize()`, `rotate()`, and `webp()`
 * return the same instance, and all processing runs off the main thread (except `metadata()`).
 *
 * Canonical Bun 1.4.4 `Bun.Image` & `Bun.WebView` contract:
 * - Off-thread terminal methods: `.bytes()`, `.buffer()`, `.blob()`, `.toBase64()`, `.dataurl()`,
 *   `.placeholder()` (ThumbHash data URL for blur-up), `.metadata()`, and `.write(dest)`.
 * - `Bun.file(path).image()` loads a `BunFile` directly into a `Bun.Image` pipeline (`await Bun.file(p).image().placeholder()`).
 * - Body integration: `new Response(buildConfiguredImage(input, options))` streams the encoded image
 *   with automatic `Content-Type` header (`image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/heic`).
 * - Platform codecs: JPEG/PNG/WebP/GIF/BMP are statically linked across all OSes; HEIC and AVIF use
 *   ImageIO + vImage on macOS (Apple Silicon) with zero startup cost via lazy symbol resolution.
 * - `view.screenshot({ encoding: "blob" })` (default) returns a zero-copy mmap-backed `Blob` on WebKit.
 * - `view.screenshot({ encoding: "base64" })` is zero-decode on Chrome (CDP returns base64 natively).
 * - `view.screenshot({ encoding: "shmem" })` writes the PNG to a POSIX shared-memory segment for Kitty (`t=s`).
 */

export type ScreenshotFormat = "png" | "jpeg" | "webp" | "avif" | "heic";
export type ScreenshotMimeType =
  "image/png" | "image/jpeg" | "image/webp" | "image/avif" | "image/heic";
export type ScreenshotEncoding = "blob" | "buffer" | "base64" | "shmem";
export type ImageBinaryInput = Uint8Array | ArrayBuffer | Blob;

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
  /** Emit a lossless WebP/AVIF/HEIC (default false). */
  readonly lossless?: boolean;
  /** Quantize PNG to a <=256-color indexed palette (3-5x smaller for UI screenshots). */
  readonly palette?: boolean;
  readonly resize?: ResizeSpec;
  /** Clockwise rotation in degrees (applied after resize, before encode). */
  readonly rotate?: number;
  /** Maximum allowed source/target pixel count (`width * height`, default 16384 * 16384). */
  readonly maxPixels?: number;
}

export interface ShmemGraphicSegment {
  readonly name: string;
  readonly size: number;
  /** Kitty graphics protocol `t=s` escape sequence (`\x1b_Gf=100,t=s,a=T,S=<size>;<b64(name)>\x1b\\`). */
  readonly kittyEscape: string;
}

const DEFAULT_MAX_PIXELS = 16_384 * 16_384;

const MAGIC: Record<"png" | "jpeg" | "webp", readonly number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpeg: [0xff, 0xd8, 0xff],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF; "WEBP" follows at offset 8
};

export const MIME_TYPE_BY_FORMAT: Readonly<
  Record<ScreenshotFormat, ScreenshotMimeType>
> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
};

export function mimeTypeForFormat(
  format: ScreenshotFormat,
): ScreenshotMimeType {
  return MIME_TYPE_BY_FORMAT[format];
}

export function looksLike(
  format: ScreenshotFormat,
  bytes: Uint8Array,
): boolean {
  if (format === "avif" || format === "heic") {
    // ISOBMFF: size(4) + "ftyp"(4) + major brand(4) at offsets 4..8 and 8..12. The major
    // brand distinguishes AVIF ("avif") from HEIC/HEIF ("heic"); checking only the ftyp box
    // would let one format's bytes pass the other's magic guard.
    if (bytes.byteLength < 12) return false;
    if (
      bytes[4] !== 0x66 ||
      bytes[5] !== 0x74 ||
      bytes[6] !== 0x79 ||
      bytes[7] !== 0x70
    ) {
      return false;
    }
    const brand = String.fromCharCode(
      bytes[8]!,
      bytes[9]!,
      bytes[10]!,
      bytes[11]!,
    );
    const expectedBrand = format === "avif" ? "avif" : "heic";
    return brand === expectedBrand;
  }
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

function inputByteLength(input: ImageBinaryInput): number {
  if (input instanceof Blob) return input.size;
  return input.byteLength;
}

/** Read `width`, `height`, and `format` from the image header (~0.004 ms, 70x faster than sharp). */
export async function readImageMetadata(
  input: ImageBinaryInput,
  maxPixels: number = DEFAULT_MAX_PIXELS,
): Promise<Bun.Image.Metadata> {
  if (inputByteLength(input) === 0) throw new Error("screenshot is empty");
  return new Bun.Image(input, { maxPixels }).metadata();
}

/**
 * Compute a ThumbHash blur-up placeholder data URL (`data:image/png;base64,...`) off the main thread
 * from either binary input or a file path via `Bun.file(path).image().placeholder()`.
 */
export async function computeImagePlaceholder(
  source: ImageBinaryInput | string,
  maxPixels: number = DEFAULT_MAX_PIXELS,
): Promise<string> {
  if (typeof source === "string") {
    return await Bun.file(source).image({ maxPixels }).placeholder();
  }
  if (inputByteLength(source) === 0) throw new Error("screenshot is empty");
  return await new Bun.Image(source, { maxPixels }).placeholder();
}

/**
 * Configure a mutable `Bun.Image` pipeline (resize + format codec).
 * Can be passed directly to `new Response(buildConfiguredImage(input, options))` for automatic
 * `Content-Type` header setting, or terminated via `.bytes()`, `.blob()`, `.toBase64()`, `.dataurl()`, or `.write(dest)`.
 */
export function buildConfiguredImage(
  input: ImageBinaryInput,
  options: EncodeOptions,
): Bun.Image {
  if (inputByteLength(input) === 0) throw new Error("screenshot is empty");
  const image = new Bun.Image(input, {
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

  if (options.rotate !== undefined) {
    const angle = options.rotate;
    if (!Number.isFinite(angle)) {
      throw new Error(`rotate angle must be finite: ${angle}`);
    }
    image.rotate(angle);
  }

  const quality = options.quality ?? 80;
  if (options.format === "png") {
    return options.palette === true
      ? image.png({ palette: true, dither: true })
      : image.png();
  }
  if (options.format === "jpeg") {
    return image.jpeg({
      quality,
      ...(options.progressive === undefined
        ? {}
        : { progressive: options.progressive }),
    });
  }
  if (options.format === "avif") {
    return image.avif({
      quality,
      ...(options.lossless === undefined ? {} : { lossless: options.lossless }),
    });
  }
  if (options.format === "heic") {
    return image.heic({
      quality,
      ...(options.lossless === undefined ? {} : { lossless: options.lossless }),
    });
  }
  return image.webp({
    quality,
    ...(options.lossless === undefined ? {} : { lossless: options.lossless }),
  });
}

export async function encodeScreenshot(
  input: ImageBinaryInput,
  options: EncodeOptions,
): Promise<Uint8Array> {
  const encoded = buildConfiguredImage(input, options);
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

/**
 * Off-thread native `.blob()` terminal on `Bun.Image`: returns a `Blob` with `blob.type`
 * set automatically (`image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/heic`).
 */
export async function encodeScreenshotBlob(
  input: ImageBinaryInput,
  options: EncodeOptions,
): Promise<Blob> {
  const encoded = buildConfiguredImage(input, options);
  if (typeof encoded.blob === "function") {
    return await encoded.blob();
  }
  const bytes = await encodeScreenshot(input, options);
  return new Blob([bytes], { type: mimeTypeForFormat(options.format) });
}

/**
 * Off-thread native `.toBase64()` and `.dataurl()` terminals on `Bun.Image`.
 */
export async function encodeScreenshotDataUrl(
  input: ImageBinaryInput,
  options: EncodeOptions,
): Promise<{
  readonly base64: string;
  readonly dataUri: string;
  readonly mimeType: ScreenshotMimeType;
}> {
  const encoded = buildConfiguredImage(input, options);
  const [base64, dataUri] = await Promise.all([
    encoded.toBase64(),
    encoded.dataurl(),
  ]);
  return {
    base64,
    dataUri,
    mimeType: mimeTypeForFormat(options.format),
  };
}

/**
 * Off-thread native `.write(dest)` terminal on `Bun.Image`.
 */
export async function writeScreenshot(
  dest: string,
  input: ImageBinaryInput,
  options: EncodeOptions,
): Promise<number> {
  const encoded = buildConfiguredImage(input, options);
  return await encoded.write(dest);
}

/** Format a data URI (`data:image/<fmt>;base64,...`) from base64 screenshot output. */
export function toScreenshotDataUri(
  base64: string,
  format: ScreenshotFormat = "png",
): string {
  return `data:${mimeTypeForFormat(format)};base64,${base64}`;
}

/**
 * Build the Kitty terminal graphics protocol `t=s` shared-memory escape sequence
 * (`\x1b_Gf=100,t=s,a=T,S=<size>;<b64(name)>\x1b\\`) from `view.screenshot({ encoding: "shmem" })`.
 * Kitty reads the PNG from the POSIX shared-memory segment and calls `shm_unlink` when done.
 */
export function formatKittyShmemEscape(segment: {
  readonly name: string;
  readonly size: number;
}): ShmemGraphicSegment {
  if (segment.name.trim() === "" || segment.size <= 0) {
    throw new Error("invalid shared-memory screenshot segment");
  }
  const encodedName = Buffer.from(segment.name, "utf8").toString("base64");
  return {
    name: segment.name,
    size: segment.size,
    kittyEscape: `\x1b_Gf=100,t=s,a=T,S=${segment.size};${encodedName}\x1b\\`,
  };
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

/** Parse integer degrees from a CLI flag (`90`, `90deg`). */
export function parseRotate(spec: string): number {
  const trimmed = spec.trim().replace(/deg$/i, "").trim();
  const angle = Number(trimmed);
  if (!Number.isFinite(angle)) {
    throw new Error(`--rotate expects degrees (got "${spec}")`);
  }
  return angle;
}
