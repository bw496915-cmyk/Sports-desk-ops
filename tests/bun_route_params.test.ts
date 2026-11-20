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
