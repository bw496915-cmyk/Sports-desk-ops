/**
 * @file tests/bun_file_routes.test.ts
 * @description Pin the static-vs-file route distinction: a `Bun.file` route
 * reads the file per request (so a changing feed is never stale), while a
 * buffered static route keeps the bytes captured at startup.
 */

import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("file routes read per request, static routes stay buffered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-file-routes-"));
  const path = join(dir, "feed.json");
  writeFileSync(path, '{"version":1}\n');
  const buffered = new Uint8Array(readFileSync(path));
  const headers = { "content-type": "application/json; charset=utf-8" };

  const server = Bun.serve({
    port: 0,
    routes: {
      "/file": new Response(Bun.file(path), { headers }),
      "/buffered": new Response(buffered, { headers }),
    },
    fetch: () => new Response("fallback", { status: 404 }),
  });
  const url = (pathname: string): string =>
    `http://127.0.0.1:${server.port}${pathname}`;

  try {
    expect(await (await fetch(url("/file"))).text()).toContain('"version":1');
    expect(await (await fetch(url("/buffered"))).text()).toContain(
      '"version":1',
    );

    writeFileSync(path, '{"version":2}\n');
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);

    expect(await (await fetch(url("/file"))).text()).toContain('"version":2');
    expect(await (await fetch(url("/buffered"))).text()).toContain(
      '"version":1',
    );
  } finally {
    server.stop(true);
    rmSync(dir, { force: true, recursive: true });
  }
});
