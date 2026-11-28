/**
 * @file lib/token_watch_avatars.ts
 * @description Avatar discovery and lazy PNG encoding for the token-watch v14 integration.
 *
 * Avatars are desk PNGs named `desk-<project>-<slug>.png` for the projects `enam`, `mut`,
 * `staging`, `dev` and `research`. Discovery is a single `Bun.Glob` scan plus a JS filter rather
 * than one clever pattern: the reviewed `desk-@(…)*!(*.test).png` extglob is accepted by
 * `Bun.Glob` but does **not** exclude `*.test.png` (measured on 1.4.4), so the exclusion has to be
 * explicit.
 *
 * `encodeAvatarBase64` pins every setting the pipeline would otherwise infer:
 * - `maxPixels` defaults to 2,000,000 — the header pixel check runs before any pixel buffer is
 *   allocated, so an oversized avatar is refused cheaply;
 * - `fit: "inside"` preserves the avatar's aspect ratio (`"fill"` is the default and would
 *   stretch it), and `withoutEnlargement` keeps small avatars at their own size;
 * - `.png()` forces the terminal format, since `toBase64()` encodes whatever format the last
 *   chainable selected.
 */

/** Desk avatar filenames for the projects the token-watch dashboard hydrates. */
export const AVATAR_GLOB_PATTERN = "desk-@(enam|mut|staging|dev|research)*.png";

/** Default decode guard: 2,000,000 px, i.e. comfortably above a real avatar. */
const DEFAULT_MAX_PIXELS = 2_000_000;

/** Geometry for one avatar encode. */
export interface AvatarEncodeOptions {
  /** Target width in terminal pixels; `resize()` fits the avatar within it. */
  readonly cols: number;
  /** Target height in terminal pixels; `resize()` fits the avatar within it. */
  readonly rows: number;
  /** Reject sources whose `width × height` exceeds this. Default 2,000,000. */
  readonly maxPixels?: number | undefined;
}

/** Why an avatar could not be encoded, keyed by the `Bun.Image` rejection code. */
export type AvatarFailure =
  "too-many-pixels" | "unsupported-format" | "unknown-format" | "decode";

/**
 * Names of the desk avatars in `avatarDir`, sorted, with test fixtures (`*.test.png`) skipped.
 *
 * `Bun.Glob.scan()` yields names relative to the scanned directory, which is the shape the
 * caller renders; the sort makes the result independent of directory iteration order.
 */
export async function listAvatarFiles(avatarDir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of new Bun.Glob(AVATAR_GLOB_PATTERN).scan(avatarDir)) {
    if (file.endsWith(".test.png")) continue;
    files.push(file);
  }
  return files.sort();
}

/** Read the `code` off an unknown rejection without assuming it is an `Error`. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Classify a failed avatar encode. Unknown shapes and codes fall back to `"decode"`: every
 * `Bun.Image` terminal runs decode → transform → encode, so a decode failure is the only safe
 * default classification.
 */
export function classifyAvatarError(error: unknown): AvatarFailure {
  switch (errorCodeOf(error)) {
    case "ERR_IMAGE_TOO_MANY_PIXELS":
      return "too-many-pixels";
    case "ERR_IMAGE_FORMAT_UNSUPPORTED":
      return "unsupported-format";
    case "ERR_IMAGE_UNKNOWN_FORMAT":
      return "unknown-format";
    case "ERR_IMAGE_DECODE_FAILED":
      return "decode";
    default:
      return "decode";
  }
}

/**
 * Decode `filePath`, fit it inside `options.cols × options.rows` without upscaling, and return
 * the PNG as base64 (no `data:` prefix).
 */
export async function encodeAvatarBase64(
  filePath: string,
  options: AvatarEncodeOptions,
): Promise<string> {
  return await Bun.file(filePath)
    .image({ maxPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS })
    .resize(options.cols, options.rows, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBase64();
}
