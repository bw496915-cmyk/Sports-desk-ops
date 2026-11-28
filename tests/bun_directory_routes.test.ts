/**
 * @file tests/bun_directory_routes.test.ts
 * @description Pin the { dir } route contract: canonical-path rejection,
 * trailing-slash redirect and index.html, weak ETag/Last-Modified, conditional
 * 304 and Range 206. The daemon deliberately keeps its realpath-contained
 * /assets handler instead, so this documents the platform behavior.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("directory routes serve files with the documented path rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-dir-routes-"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "file.txt"), "hello\n");
  writeFileSync(join(dir, "index.html"), "<h1>root</h1>\n");
  writeFileSync(join(dir, "nested", "index.html"), "<h1>nested</h1>\n");

  const server = Bun.serve({
    port: 0,
    routes: { "/static/*": { dir } },
    fetch: () => new Response("fallback", { status: 404 }),
  });
  const url = (path: string): string =>
    `http://127.0.0.1:${server.port}${path}`;

  try {
    const file = await fetch(url("/static/file.txt"));
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("hello\n");
    expect(file.headers.get("content-type")).toContain("text/plain");
    expect(file.headers.get("last-modified")).not.toBeNull();
    expect(file.headers.get("etag")).toStartWith('W/"');
    expect(file.headers.get("accept-ranges")).toBe("bytes");

    const etag = file.headers.get("etag") ?? "";
    const conditional = await fetch(url("/static/file.txt"), {
      headers: { "if-none-match": etag },
    });
    expect(conditional.status).toBe(304);

    const ranged = await fetch(url("/static/file.txt"), {
      headers: { range: "bytes=0-1" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toStartWith("bytes 0-1/");

    const redirect = await fetch(url("/static/nested"), {
      redirect: "manual",
    });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/static/nested/");

    const index = await fetch(url("/static/nested/"));
    expect(index.status).toBe(200);
    expect(await index.text()).toBe("<h1>nested</h1>\n");

    for (const path of [
      "/static/%2e%2e/secret.txt",
      "/static//file.txt",
      "/static/missing.txt",
    ]) {
      expect((await fetch(url(path))).status).toBe(404);
    }
  } finally {
    server.stop(true);
    rmSync(dir, { force: true, recursive: true });
  }
});
