/**
 * @file tests/bun_route_reload.test.ts
 * @description Pin `server.reload()` for static route responses: Bun caches
 * static routes for the server's lifetime, and reload replaces both the route
 * table and the fetch fallback without dropping the listening socket.
 */

import { expect, test } from "bun:test";

test("server.reload replaces cached static routes and the fetch fallback", async () => {
  const server = Bun.serve({
    port: 0,
    routes: { "/v": new Response("v1") },
    fetch: () => new Response("f1"),
  });
  const url = (path: string): string =>
    `http://127.0.0.1:${server.port}${path}`;

  try {
    expect(await (await fetch(url("/v"))).text()).toBe("v1");
    expect(await (await fetch(url("/missing"))).text()).toBe("f1");

    server.reload({
      routes: { "/v": new Response("v2"), "/new": new Response("added") },
      fetch: () => new Response("f2"),
    });

    expect(await (await fetch(url("/v"))).text()).toBe("v2");
    expect(await (await fetch(url("/new"))).text()).toBe("added");
    expect(await (await fetch(url("/missing"))).text()).toBe("f2");
  } finally {
    server.stop(true);
  }
});
