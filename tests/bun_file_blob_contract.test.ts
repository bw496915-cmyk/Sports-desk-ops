import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bun 1.4.4 file/blob/image behavior, measured 2026-11-14.
 *
 * Divergences from the file-types page:
 *  - Bun.file().type includes a charset ("application/json;charset=utf-8"); the
 *    page shows the bare MIME type.
 *  - image().width/height are -1 until the image is decoded; metadata() is the
 *    reliable accessor and populates them.
 *  - "For empty Blob, exists() always returns true" holds for in-memory blobs;
 *    a zero-length slice of a missing file-backed blob returns false.
 */

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "bun-file-contract-"));
}

// Blob.exists() exists at runtime but is not in @types/bun 1.4.4.
function blobExists(blob: Blob): Promise<boolean> {
  return (blob as Blob & { exists(): Promise<boolean> }).exists();
}

describe("Bun.file", () => {
  test("type carries a charset and text/json read correctly", async () => {
    const dir = temp();
    try {
      const file = Bun.file(join(dir, "hello.json"));
      await Bun.write(file, '{"hello":"world"}');
      expect(file.type).toBe("application/json;charset=utf-8");
      expect(await file.text()).toBe('{"hello":"world"}');
      expect(await file.json()).toEqual({ hello: "world" });
      expect(file.size).toBe(17);
      expect(await file.exists()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing files fail at the operation, not at Response construction", async () => {
    const dir = temp();
    try {
      const missing = Bun.file(join(dir, "nope.txt"));
      expect(await missing.exists()).toBe(false);

      let textError: unknown;
      try {
        await missing.text();
      } catch (e) {
        textError = e;
      }
      expect(textError).toBeInstanceOf(Error);
      expect((textError as NodeJS.ErrnoException).code).toBe("ENOENT");

      // The docs' HTTP pattern: construct the Response, handle the failure when the
      // body is consumed (a server error handler), rather than stat-then-open.
      const response = new Response(missing);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(response.headers.get("content-length")).toBeNull();

      let bodyError: unknown;
      try {
        await response.arrayBuffer();
      } catch (e) {
        bodyError = e;
      }
      expect(bodyError).toBeInstanceOf(Error);
      expect((bodyError as NodeJS.ErrnoException).code).toBe("ENOENT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Blob additions", () => {
  test("exists() is true for in-memory blobs, false for missing files", async () => {
    const dir = temp();
    try {
      const missing = Bun.file(join(dir, "missing.bin"));
      expect(await blobExists(new Blob([]))).toBe(true);
      expect(await blobExists(new Blob(["x"]))).toBe(true);
      expect(await missing.exists()).toBe(false);
      // A zero-length slice of a missing file-backed blob is NOT reliable:
      // measured true on a reused handle and false on a fresh one, so the
      // "empty Blob exists" rule is only pinned for in-memory blobs above.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formData() parses by the blob's type", async () => {
    const urlencoded = new Blob(["a=1&b=two+words&c=%E2%9C%93"], {
      type: "application/x-www-form-urlencoded",
    });
    const fd = await urlencoded.formData();
    expect(fd.get("a")).toBe("1");
    expect(fd.get("b")).toBe("two words");
    expect(fd.get("c")).toBe("✓");

    const boundary = "----probe123";
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="field1"',
      "",
      "value1",
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
      "Content-Type: text/plain",
      "",
      "file-content",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const mp = new Blob([multipart], {
      type: `multipart/form-data; boundary=${boundary}`,
    });
    const mpForm = await mp.formData();
    expect(mpForm.get("field1")).toBe("value1");
    const uploaded = mpForm.get("file") as File;
    expect(uploaded.name).toBe("a.txt");
    expect(await uploaded.text()).toBe("file-content");

    // A type that names no supported format is an error, not an empty result.
    let invalid: unknown;
    try {
      await new Blob(["a=1"], { type: "text/plain" }).formData();
    } catch (e) {
      invalid = e;
    }
    expect(invalid).toBeInstanceOf(Error);
    expect((invalid as Error).message).toContain("Invalid encoding");

    const empty = await new Blob([]).formData();
    expect([...empty.entries()]).toEqual([]);
  });
});

describe("Bun.image", () => {
  test("metadata() is reliable; width/height are lazy until decode", async () => {
    const dir = temp();
    try {
      const pngPath = join(dir, "one.png");
      await Bun.write(pngPath, Buffer.from(ONE_PX_PNG, "base64"));
      const file = Bun.file(pngPath);
      expect(file.type).toBe("image/png");

      const image = file.image();
      // Lazy handles report -1/-1 until the image is decoded.
      expect({ width: image.width, height: image.height }).toEqual({ width: -1, height: -1 });

      expect(await image.metadata()).toEqual({ width: 1, height: 1, format: "png" });
      expect({ width: image.width, height: image.height }).toEqual({ width: 1, height: 1 });

      const out = join(dir, "thumb.webp");
      await image.resize(4).webp().write(out);
      const written = Bun.file(out);
      expect(written.type).toBe("image/webp");
      expect(await written.exists()).toBe(true);
      expect(written.size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
