import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("GET /api/live-wagers", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  const get = (path: string) => fetch(`${server.url}${path}`);

  test("answers 404 with the save hint when no capture exists", async () => {
    const res = await get("api/live-wagers");
    expect([200, 404]).toContain(res.status);
    const body = (await res.json()) as {
      hint?: string;
      summary?: { count: number };
      wagers?: unknown[];
    };
    if (res.status === 404) {
      expect(body.hint).toContain("data/live-wagers.json");
    } else {
      expect(body.wagers?.length).toBe(body.summary?.count);
    }
  });

  test("reports the whole list alongside any filtered view", async () => {
    const body = (await (await get("api/live-wagers")).json()) as {
      all?: { count: number };
      summary?: { count: number };
    };
    if (body.all === undefined) return; // no capture in this checkout
    expect(body.all.count).toBeGreaterThanOrEqual(body.summary?.count ?? 0);
  });

  test("filters by writer and type without inventing values", async () => {
    const base = (await (await get("api/live-wagers")).json()) as {
      wagers?: Array<{ writer: string; wagerType: string }>;
    };
    if (base.wagers === undefined || base.wagers.length === 0) return;

    const writer = base.wagers[0]?.writer;
    const filtered = (await (
      await get(`api/live-wagers?writer=${writer}`)
    ).json()) as {
      wagers: Array<{ writer: string }>;
      summary: { count: number };
    };
    expect(filtered.wagers.every((w) => w.writer === writer)).toBe(true);
    expect(filtered.summary.count).toBe(filtered.wagers.length);

    const none = (await (await get("api/live-wagers?type=NOPE")).json()) as {
      summary: { count: number };
    };
    expect(none.summary.count).toBe(0);
  });
});
