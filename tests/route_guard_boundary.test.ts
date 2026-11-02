import { describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { DAEMON_ROUTES } from "../lib/daemon_routes.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * The guard, tested at the network boundary rather than through the code that implements it.
 *
 * Every existing server test connects over loopback, where `piiRejection` deliberately allows the
 * request — so a route that lost its guard call would pass the whole suite. That is not
 * hypothetical: /graph and /api/analysis both served customer identifiers unguarded while the
 * table claimed otherwise, and no test could see it.
 *
 * This binds 0.0.0.0, connects from a non-loopback address, and asserts the routes the table
 * marks `pii` refuse the request. An unguarded route is the control: if it also refused, the
 * failure would be the network, not the guard.
 *
 * Skips cleanly when the machine has no non-loopback IPv4, rather than passing vacuously and
 * reporting coverage it does not have.
 */

const lan = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
  ?.address;

const piiRoutes = DAEMON_ROUTES.filter((route) => route.guard === "pii").map((route) => route.path);
const publicControl = DAEMON_ROUTES.find(
  (route) => route.guard === "none" && route.path === "/api/sports",
);

describe.skipIf(lan === undefined)("pii routes refuse a non-loopback peer", () => {
  const server = startServer({ port: 0, hostname: "0.0.0.0" });
  const base = `http://${lan ?? "127.0.0.1"}:${server.port}`;

  test("the table marks something as pii (the loop below is not empty)", () => {
    expect(piiRoutes.length).toBeGreaterThan(3);
  });

  test("an unguarded route still answers — so a refusal below means the guard, not the network", async () => {
    const route = publicControl;
    expect(route).toBeDefined();
    const response = await fetch(`${base}${route?.path ?? "/api/sports"}`);
    expect([200, 400, 404, 410]).toContain(response.status);
  });

  for (const path of piiRoutes) {
    test(`${path} -> 401/403/503 without a token`, async () => {
      const response = await fetch(`${base}${path}`);
      // 400 or 200 here would mean the arm parsed or answered before guarding.
      expect([401, 403, 503]).toContain(response.status);
    });
  }

  test("a wrong bearer is refused too, not just an absent one", async () => {
    const response = await fetch(`${base}/api/live-bets`, {
      headers: { Authorization: "Bearer not-the-token" },
    });
    expect([401, 403, 503]).toContain(response.status);
  });

  // Stop listening once the file's tests have run.
  test("cleanup", () => {
    server.stop(true);
    expect(true).toBe(true);
  });
});
