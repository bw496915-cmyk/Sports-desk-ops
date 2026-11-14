import { describe, expect, test } from "bun:test";
import { pickApiTarget } from "../lib/dashboard_preview_routing.ts";

const api = "http://127.0.0.1:4020";
const feedsApi = "http://127.0.0.1:4021";

describe("pickApiTarget", () => {
  test("keeps everything on the daemon when no feed host is configured", () => {
    expect(pickApiTarget("/api/wagers", { api })).toBe(api);
    expect(pickApiTarget("/api/alerts", { api, feedsApi: "" })).toBe(api);
  });

  test("sends the four feed reads to the feed host", () => {
    for (const path of [
      "/api/config/tiers",
      "/api/customers",
      "/api/wagers",
      "/api/dashboard",
    ]) {
      expect(pickApiTarget(path, { api, feedsApi })).toBe(feedsApi);
    }
  });

  test("leaves operational routes on the daemon", () => {
    for (const path of [
      "/api/alerts",
      "/api/dns/telemetry",
      "/api/terminal/exec",
      "/health",
    ]) {
      expect(pickApiTarget(path, { api, feedsApi })).toBe(api);
    }
  });
});
