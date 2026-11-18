/**
 * @file tests/bun_thumbnail.test.ts
 * @description `writeWebpThumbnail` pins `Bun.Image.backend = "bun"` for portable geometry,
 * applies `fit: "inside"` with `withoutEnlargement`, and returns the measured WebP attributes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  thumbnailDestination,
  writeWebpThumbnail,
} from "../lib/bun_thumbnail.ts";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const dir = mkdtempSync(join(tmpdir(), "sd-thumb-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function makePng(
  path: string,
  width: number,
  height: number,
): Promise<void> {
  const source = Uint8Array.from(Buffer.from(PNG_1X1_BASE64, "base64"));
  const bytes = await new Bun.Image(source).resize(width, height).png().bytes();
  writeFileSync(path, bytes);
}

describe("writeWebpThumbnail", () => {
  test("caps the long edge and writes a WebP with the pinned backend", async () => {
    const source = join(dir, "wide.png");
    const destination = join(dir, "thumbs", "wide.png.thumb.webp");
    await makePng(source, 120, 90);

    const thumb = await writeWebpThumbnail(source, destination, {
      maxEdge: 40,
    });

    expect(thumb.width).toBe(40);
    expect(thumb.height).toBe(30);
    expect(thumb.format).toBe("webp");
    expect(thumb.backend).toBe("bun");
    expect(thumb.quality).toBe(80);
    expect(thumb.bytesWritten).toBe(Bun.file(destination).size);
    expect(await new Bun.Image(Bun.file(destination)).metadata()).toEqual({
      width: 40,
      height: 30,
      format: "webp",
    });
  });

  test("withoutEnlargement leaves a smaller image at its own size", async () => {
    const source = join(dir, "small.png");
    const destination = join(dir, "small.thumb.webp");
    await makePng(source, 20, 10);

    const thumb = await writeWebpThumbnail(source, destination, {
      maxEdge: 100,
    });

    expect(thumb.width).toBe(20);
    expect(thumb.height).toBe(10);
  });

  test("validates the edge, quality and destination", async () => {
    const source = join(dir, "bad.png");
    await makePng(source, 10, 10);
    const destination = join(dir, "bad.thumb.webp");

    await expect(
      writeWebpThumbnail(source, destination, { maxEdge: 0 }),
    ).rejects.toThrow("maxEdge must be an integer");
    await expect(
      writeWebpThumbnail(source, destination, { quality: 101 }),
    ).rejects.toThrow("quality must be an integer");
    await expect(
      writeWebpThumbnail(source, source, { maxEdge: 10 }),
    ).rejects.toThrow("must differ from the source");
    await expect(
      writeWebpThumbnail(join(dir, "missing.png"), destination),
    ).rejects.toThrow("source image not found");
  });

  test("thumbnailDestination keeps subdirectories and cannot escape", () => {
    const root = join(dir, "assets");
    expect(
      thumbnailDestination(
        root,
        join(root, "nested", "a.png"),
        join(root, ".thumbs"),
      ),
    ).toBe(join(root, ".thumbs", "nested", "a.png.thumb.webp"));
    expect(
      thumbnailDestination(
        root,
        join(dir, "elsewhere", "b.png"),
        join(root, ".thumbs"),
      ),
    ).toBe(join(root, ".thumbs", "b.png.thumb.webp"));
  });
});
