import { describe, expect, test } from "bun:test";

/**
 * Screenshot encodings on the WebKit backend (macOS only).
 *
 * The reference says webp is Chrome-only, `quality` is ignored for PNG, and shmem names follow
 * `/bun-webview-<pid>-<seq>`. Pinned because the shot tool and the encode path depend on whichever
 * encoding they request.
 */
const darwin = process.platform === "darwin";

describe.skipIf(!darwin)("WebKit screenshots", () => {
  const withView = async (
    run: (view: Bun.WebView) => Promise<void>,
  ): Promise<void> => {
    const view = new Bun.WebView({
      backend: "webkit",
      width: 160,
      height: 100,
    });
    try {
      await view.navigate("data:text/html,<h1>x</h1>");
      await run(view);
    } finally {
      await view.close();
    }
  };

  test("buffer returns a PNG Buffer with the right magic", async () => {
    await withView(async (view) => {
      const buffer = await view.screenshot({ encoding: "buffer" });
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer[0]).toBe(0x89);
      expect(buffer[1]).toBe(0x50);
      expect(buffer.byteLength).toBeGreaterThan(0);
    });
  });

  test("webp throws on webkit", async () => {
    await withView(async (view) => {
      // The rejection can surface synchronously, so capture it explicitly rather than via .rejects.
      let message = "";
      try {
        await view.screenshot({ format: "webp" });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("requires backend");
    });
  });

  test("quality is ignored for png", async () => {
    await withView(async (view) => {
      const low = await view.screenshot({
        format: "png",
        quality: 1,
        encoding: "buffer",
      });
      const high = await view.screenshot({
        format: "png",
        quality: 100,
        encoding: "buffer",
      });
      const digest = (bytes: Uint8Array): string =>
        new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      expect(digest(low)).toBe(digest(high));
    });
  });

  test("shmem follows the documented name pattern and size", async () => {
    await withView(async (view) => {
      const first = await view.screenshot({ encoding: "shmem" });
      const second = await view.screenshot({ encoding: "shmem" });
      expect(first.name).toMatch(/^\/bun-webview-\d+-\d+$/);
      expect(first.size).toBeGreaterThan(0);
      // Each call allocates a new segment; callers must unlink or the segment lives until exit.
      expect(second.name).not.toBe(first.name);
    });
  });
});
