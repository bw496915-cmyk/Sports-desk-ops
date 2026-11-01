/**
 * @file lib/screenshot_encode.ts
 * @description Re-encode WebView screenshots with Bun.Image.
 *
 * The WebKit backend can only produce png/jpeg, so webp and resizing are done after the fact rather
 * than by forcing the Chrome backend. `Bun.Image` is mutable: `resize()` and `webp()` return the same
 * instance, so the order of operations is visible in the chain below.
 */

export type ScreenshotFormat = "png" | "jpeg" | "webp";

export interface EncodeOptions {
  readonly format: ScreenshotFormat;
  /** 0-100; ignored for png. */
  readonly quality?: number;
  readonly resize?: { readonly width: number; readonly height?: number };
}

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
  return magic.every((byte, index) => bytes[index] === byte);
}

export async function encodeScreenshot(
  png: Uint8Array,
  options: EncodeOptions,
): Promise<Uint8Array> {
  if (png.byteLength === 0) throw new Error("screenshot is empty");
  const image = new Bun.Image(png);

  if (options.resize !== undefined) {
    const { width, height } = options.resize;
    if (!Number.isInteger(width) || width < 1 || width > 16384) {
      throw new Error(`resize width out of range: ${width}`);
    }
    if (height === undefined) {
      image.resize(width);
    } else {
      if (!Number.isInteger(height) || height < 1 || height > 16384) {
        throw new Error(`resize height out of range: ${height}`);
      }
      image.resize(width, height);
    }
  }

  const quality = options.quality ?? 80;
  const encoded =
    options.format === "png"
      ? image.png()
      : options.format === "jpeg"
        ? image.jpeg({ quality })
        : image.webp({ quality });

  const buffer = await encoded.toBuffer();
  const bytes = new Uint8Array(buffer);
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
