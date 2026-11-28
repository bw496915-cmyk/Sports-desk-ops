/**
 * @file tests/bun_route_params.test.ts
 * @description Pin the Bun.serve route contracts the server relies on now that
 * it registers routes: exact-before-parameter precedence, decoded parameters,
 * invalid-encoding replacement, wildcards, static responses and fetch fallback.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    routes: {
      "/users/me": () => new Response("me"),
      "/users/:id": (req) => Response.json({ id: req.params.id }),
      "/async/:id": async (req) =>
        Response.json({ id: req.params.id, async: true }),
      "/promised": () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response("promised")), 5);
        }),
      "/files/*": (req) => new Response(new URL(req.url).pathname),
      "/healthz": new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    },
    fetch: () => new Response("fallback", { status: 404 }),
  });
});

afterAll(() => {
  server.stop(true);
});

function url(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

describe("Bun.serve routes", () => {
  test("an exact route wins over a parameter route", async () => {
    const response = await fetch(url("/users/me"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("me");
  });

  test("a parameter route exposes the path segment", async () => {
    const response = await fetch(url("/users/42"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "42" });
  });

  test("a percent-encoded parameter is decoded", async () => {
    const response = await fetch(url("/users/%E2%9C%93"));

    expect(await response.json()).toEqual({ id: "✓" });
  });

  test("invalid encoding becomes the Unicode replacement character", async () => {
    const response = await fetch(url("/users/%E0%A4%A"));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("\uFFFD");
  });

  test("an async handler returns a Promise<Response>", async () => {
    const response = await fetch(url("/async/7"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "7", async: true });
  });

  test("a handler may return a Promise<Response>", async () => {
    const response = await fetch(url("/promised"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("promised");
  });

  test("a wildcard route matches the remaining path", async () => {
    const response = await fetch(url("/files/a/b"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/files/a/b");
  });

  test("a static Response route dispatches without a handler", async () => {
    const response = await fetch(url("/healthz"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect((await response.text()).trim()).toBe("ok");
  });

  test("unmatched requests reach the fetch fallback", async () => {
    const response = await fetch(url("/nope"));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("fallback");
  });
});

test("route precedence: exact, parameter, wildcard, catch-all", async () => {
  const server = Bun.serve({
    port: 0,
    routes: {
      "/api/users/me": () => new Response("exact"),
      "/api/users/:id": (req) => new Response(`param:${req.params.id}`),
      "/api/*": () => new Response("wildcard"),
      "/*": () => new Response("catch-all"),
    },
  });
  const url = (path: string): string =>
    `http://127.0.0.1:${server.port}${path}`;

  try {
    expect(await (await fetch(url("/api/users/me"))).text()).toBe("exact");
    expect(await (await fetch(url("/api/users/42"))).text()).toBe("param:42");
    expect(await (await fetch(url("/api/other"))).text()).toBe("wildcard");
    expect(await (await fetch(url("/elsewhere"))).text()).toBe("catch-all");
  } finally {
    server.stop(true);
  }
});
