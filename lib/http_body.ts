/**
 * @file lib/http_body.ts
 * @description Read a response body once and summarize it as exact bytes plus a preview.
 *
 * `await response.text()` followed by `text.length` reports characters, not bytes: three bytes of a
 * multi-byte character count as one. Reading the buffer first gives the byte count the server actually
 * sent and decodes only the preview, instead of encoding the whole body a second time.
 */

export interface BodySummary {
  /** Exact bytes received, independent of the text encoding. */
  readonly bytes: number;
  /** Decoded prefix, at most `previewBytes` bytes of the original. */
  readonly preview: string;
  readonly truncated: boolean;
}

export async function summarizeBody(
  response: Response,
  previewBytes = 2_000,
): Promise<BodySummary> {
  const buffer = new Uint8Array(await response.arrayBuffer());
  const limit = Math.max(0, Math.trunc(previewBytes));
  const slice = buffer.subarray(0, Math.min(limit, buffer.byteLength));
  // A slice can end mid-character; TextDecoder substitutes U+FFFD rather than throwing, which is the
  // right trade for a preview.
  return {
    bytes: buffer.byteLength,
    preview: new TextDecoder().decode(slice),
    truncated: buffer.byteLength > slice.byteLength,
  };
}
