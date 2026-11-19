/**
 * @file tests/token_watch_avatars.test.ts
 * @description Discovery and lazy PNG encode for the token-watch v14 avatars.
 *
 * Fixtures are generated per test (solid-colour PNGs assembled from `deflateSync` + CRC chunks) in
 * a `mkdtemp` directory that `afterAll` removes, so no binary is committed and the `.test.png`
 * exclusion is exercised against real files rather than a stub scan.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  AVATAR_GLOB_PATTERN,
  classifyAvatarError,
  encodeAvatarBase64,
  listAvatarFiles,
} from "../lib/token_watch_avatars.ts";

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const createdDirs: string[] = [];

/** A fresh temp directory, removed with the rest in `afterAll`. */
function tempAvatarDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "token-watch-avatars-"));
  createdDirs.push(dir);
  return dir;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const chunk = new Uint8Array(4 + body.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return chunk;
}

/** A valid 8-bit RGB PNG of `width × height` filled with black pixels. */
function makePng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour (RGB)
  const rowBytes = width * 3;
  const raw = new Uint8Array(height * (rowBytes + 1)); // filter byte + RGB
  const parts: Uint8Array[] = [
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected a rejection");
}

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

describe("token-watch avatars", () => {
  test("lists only the non-test desk avatars, sorted", async () => {
    expect(AVATAR_GLOB_PATTERN).toBe(
      "desk-@(enam|mut|staging|dev|research)*.png",
    );
    const dir = tempAvatarDir();
    const png = makePng(2, 2);
    const files = [
      "desk-enam-01.png",
      "desk-enam-01.test.png",
      "desk-mut-foo.png",
      "desk-dev-2.test.png",
      "desk-staging.png",
      "desk-research-x.png",
      "desk-other.png",
      "xdesk-enam-01.png",
      "desk-enam-01.png.bak",
    ];
    for (const file of files) writeFileSync(join(dir, file), png);

    const listed = await listAvatarFiles(dir);

    expect(listed).toEqual([
      "desk-enam-01.png",
      "desk-mut-foo.png",
      "desk-research-x.png",
      "desk-staging.png",
    ]);
    expect(listed.some((file) => file.endsWith(".test.png"))).toBe(false);
  });

  test("encodes a generated PNG to base64 PNG", async () => {
    const dir = tempAvatarDir();
    const path = join(dir, "desk-enam-01.png");
    writeFileSync(path, makePng(2, 2));

    const encoded = await encodeAvatarBase64(path, { cols: 8, rows: 8 });

    expect(encoded.startsWith("iVBOR")).toBe(true);
  });

  test("rejects an image over the pixel cap as too-many-pixels", async () => {
    const dir = tempAvatarDir();
    const path = join(dir, "desk-mut-big.png");
    writeFileSync(path, makePng(1600, 1600)); // 2,560,000 px > the 2,000,000 default

    const error = await rejection(() =>
      encodeAvatarBase64(path, { cols: 8, rows: 8 }),
    );

    expect(classifyAvatarError(error)).toBe("too-many-pixels");
  });

  test("classifies a non-image file as unknown-format", async () => {
    const dir = tempAvatarDir();
    const path = join(dir, "desk-dev-2.png");
    writeFileSync(path, "this is not a PNG\n");

    const error = await rejection(() =>
      encodeAvatarBase64(path, { cols: 8, rows: 8 }),
    );
    // Measured on the pin: the sniffer rejects this input with ERR_IMAGE_UNKNOWN_FORMAT.
    expect(classifyAvatarError(error)).toBe("unknown-format");
  });

  test("resize fits inside without enlarging and the terminal is PNG", async () => {
    const dir = tempAvatarDir();
    const wide = join(dir, "desk-enam-wide.png");
    writeFileSync(wide, makePng(100, 50));
    const small = join(dir, "desk-mut-small.png");
    writeFileSync(small, makePng(4, 2));

    const wideBase64 = await encodeAvatarBase64(wide, { cols: 10, rows: 100 });
    const smallBase64 = await encodeAvatarBase64(small, { cols: 8, rows: 8 });

    const dims = (base64: string): { width: number; height: number } => {
      const bytes = Buffer.from(base64, "base64");
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    };

    // fit:"inside" preserves the 2:1 aspect; withoutEnlargement leaves 4x2 alone in an 8x8 box.
    expect(dims(wideBase64)).toEqual({ width: 10, height: 5 });
    expect(dims(smallBase64)).toEqual({ width: 4, height: 2 });
  });
});
