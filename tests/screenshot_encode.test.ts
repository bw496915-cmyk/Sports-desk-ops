import { describe, expect, test } from "bun:test";
import {
  encodeScreenshot,
  looksLike,
  parseResize,
} from "../lib/screenshot_encode.ts";

// 1x1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

describe("screenshot encoding", () => {
  test("parses resize specs", () => {
    expect(parseResize("320")).toEqual({ width: 320 });
    expect(parseResize("320x200")).toEqual({ width: 320, height: 200 });
    expect(() => parseResize("320px")).toThrow("WxH");
    expect(() => parseResize("x200")).toThrow("WxH");
  });

  test("detects each format by magic bytes", () => {
    expect(looksLike("png", PNG)).toBe(true);
    expect(looksLike("jpeg", PNG)).toBe(false);
    expect(looksLike("webp", PNG)).toBe(false);
  });

  test("encodes webp from a png without the Chrome backend", async () => {
    const webp = await encodeScreenshot(PNG, { format: "webp", quality: 70 });
    expect(looksLike("webp", webp)).toBe(true);
    // RIFF....WEBP
    expect(new TextDecoder().decode(webp.slice(8, 12))).toBe("WEBP");
  });

  test("encodes jpeg and png, and resizes", async () => {
    const jpeg = await encodeScreenshot(PNG, { format: "jpeg", quality: 50 });
    expect(looksLike("jpeg", jpeg)).toBe(true);

    const resized = await encodeScreenshot(PNG, {
      format: "png",
      resize: { width: 4, height: 3 },
    });
    const image = new Bun.Image(resized);
    await image.metadata();
    expect(looksLike("png", resized)).toBe(true);
  });

  test("rejects empty input and out-of-range sizes", async () => {
    await expect(
      encodeScreenshot(new Uint8Array(), { format: "png" }),
    ).rejects.toThrow("empty");
    await expect(
      encodeScreenshot(PNG, { format: "png", resize: { width: 0 } }),
    ).rejects.toThrow("out of range");
    await expect(
      encodeScreenshot(PNG, {
        format: "png",
        resize: { width: 2, height: 20000 },
      }),
    ).rejects.toThrow("out of range");
  });
});
