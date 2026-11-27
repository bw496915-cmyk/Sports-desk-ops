/**
 * Cloudflare Worker entrypoint for `ticks.bookdeskops.com` (`ppm-live-ticks`).
 *
 * Routes:
 *  - `GET  /health`                          — safe non-PII collector status (unauthenticated)
 *  - `GET  /ticks?eids=1,2&from=...&to=...`  — query Partner 118 live ticks (bearer-authenticated)
 *  - `POST /evaluate`                        — evaluate a bet timing window against ticks (bearer)
 *  - `POST /flush`                           — trigger immediate R2 ETag CAS flush (bearer)
 *  - `POST /start`                           — start/ensure collector & alarm watchdog (bearer)
 *  - `POST /stop`                            — stop collector & clear alarm watchdog (bearer)
 *  - `scheduled()`                           — cron watchdog keeping singleton DO alive
 *
 * @file workers/ppm-live-ticks/src/index.ts
 */

import { timingSafeBearerMatch } from "./clocks.ts";
import {
  PpmLiveTicksCollectorDO,
  type BetAnomalyEvaluationInput,
} from "./collector_do.ts";
import type { PpmFeedFlavor } from "./spandora_wire.ts";

export { PpmLiveTicksCollectorDO };

function parseFlavor(raw: string | null): PpmFeedFlavor {
  return raw?.trim().toLowerCase() === "prematch" ? "prematch" : "live";
}

function collectorNameForFlavor(flavor: PpmFeedFlavor): string {
  return flavor === "prematch" ? "partner-118-prematch" : "partner-118-live";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseEventIdsParam(raw: string | null): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) out.push(n);
    if (out.length >= 100) break;
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const flavor = parseFlavor(url.searchParams.get("flavor"));
    const stub = env.PPM_TICKS_COLLECTOR.getByName(
      collectorNameForFlavor(flavor),
    );

    if (request.method === "GET" && url.pathname === "/health") {
      const status = await stub.getStatus();
      return jsonResponse({ ok: true, status });
    }

    // All operational & query routes fail closed unless TICKS_API_TOKEN matches in constant time.
    const authorized = await timingSafeBearerMatch(
      request.headers.get("authorization"),
      env.TICKS_API_TOKEN,
    );
    if (!authorized) {
      console.error(
        JSON.stringify({
          service: "ppm-live-ticks",
          message: "unauthorized request",
          method: request.method,
          path: url.pathname,
        }),
      );
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    if (request.method === "GET" && url.pathname === "/ticks") {
      const eids = parseEventIdsParam(url.searchParams.get("eids"));
      if (eids.length === 0) {
        return jsonResponse(
          { ok: false, error: "missing valid eids query param" },
          400,
        );
      }
      const fromMs = Number(url.searchParams.get("from") ?? "0");
      const toMs = Number(
        url.searchParams.get("to") ?? String(Number.MAX_SAFE_INTEGER),
      );
      const limit = Number(url.searchParams.get("limit") ?? "2000");
      const ticks = await stub.queryTicks(
        eids,
        Number.isFinite(fromMs) ? fromMs : 0,
        Number.isFinite(toMs) ? toMs : Number.MAX_SAFE_INTEGER,
        Number.isFinite(limit) ? limit : 2000,
      );
      return jsonResponse({
        ok: true,
        taxonomy: {
          office: env.OFFICE,
          supplier: env.SUPPLIER,
          partnerId: Number(env.PARTNER_ID),
          endpoint: env.ENDPOINT,
          provenance: env.PROVENANCE,
        },
        count: ticks.length,
        ticks,
      });
    }

    if (request.method === "GET" && url.pathname === "/lines") {
      const eids = parseEventIdsParam(url.searchParams.get("eids"));
      if (eids.length === 0) {
        return jsonResponse(
          { ok: false, error: "missing valid eids query param" },
          400,
        );
      }
      const fromMs = Number(url.searchParams.get("from") ?? "0");
      const toMs = Number(
        url.searchParams.get("to") ?? String(Number.MAX_SAFE_INTEGER),
      );
      const limit = Number(url.searchParams.get("limit") ?? "2000");
      const closingOnly =
        url.searchParams.get("closingOnly") === "1" ||
        url.searchParams.get("closingOnly")?.toLowerCase() === "true";
      const lines = await stub.queryLines(eids, {
        fromMs: Number.isFinite(fromMs) ? fromMs : 0,
        toMs: Number.isFinite(toMs) ? toMs : Number.MAX_SAFE_INTEGER,
        closingOnly,
        marketKind: url.searchParams.get("market"),
        periodKind: url.searchParams.get("period"),
        limit: Number.isFinite(limit) ? limit : 2000,
      });
      return jsonResponse({
        ok: true,
        flavor,
        lineSet: env.PPM_LINE_SET,
        taxonomy: {
          office: env.OFFICE,
          supplier: env.SUPPLIER,
          partnerId: Number(env.PARTNER_ID),
          endpoint: env.ENDPOINT,
          provenance: env.PROVENANCE,
        },
        count: lines.length,
        lines,
      });
    }

    if (request.method === "POST" && url.pathname === "/evaluate") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: "invalid JSON body" }, 400);
      }
      if (!body || typeof body !== "object") {
        return jsonResponse(
          { ok: false, error: "request body must be an object" },
          400,
        );
      }
      const raw = body as Record<string, unknown>;
      const eventId = Number(raw.eventId);
      const placedMs = Number(raw.placedMs);
      const acceptedMs = Number(raw.acceptedMs ?? raw.placedMs);
      if (
        !Number.isInteger(eventId) ||
        eventId <= 0 ||
        !Number.isFinite(placedMs)
      ) {
        return jsonResponse(
          { ok: false, error: "eventId and placedMs are required" },
          400,
        );
      }
      const evalInput: BetAnomalyEvaluationInput = {
        eventId,
        placedMs,
        acceptedMs: Number.isFinite(acceptedMs) ? acceptedMs : placedMs,
        ...(typeof raw.snipeThresholdMs === "number"
          ? { snipeThresholdMs: raw.snipeThresholdMs }
          : {}),
        ...(typeof raw.stallWindowMs === "number"
          ? { stallWindowMs: raw.stallWindowMs }
          : {}),
      };
      const evaluation = await stub.evaluateBet(evalInput);
      return jsonResponse({ ok: true, evaluation });
    }

    if (request.method === "GET" && url.pathname === "/leagues") {
      const ids = parseEventIdsParam(url.searchParams.get("ids"));
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const leagues = await stub.queryLeagues(
        ids.length > 0 ? ids : undefined,
        Number.isFinite(limit) ? limit : 200,
      );
      return jsonResponse({ ok: true, flavor, count: leagues.length, leagues });
    }

    if (request.method === "POST" && url.pathname === "/flush") {
      const result = await stub.flushNow();
      return jsonResponse({ ok: true, result });
    }

    if (request.method === "POST" && url.pathname === "/start") {
      const status = await stub.ensureRunning(flavor);
      return jsonResponse({ ok: true, status });
    }

    if (request.method === "POST" && url.pathname === "/stop") {
      const status = await stub.stopCollector();
      return jsonResponse({ ok: true, status });
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      try {
        await stub.resetIsolate();
      } catch {
        // Expected: ctx.abort() terminates the old DO isolate immediately so the next call loads new code
      }
      return jsonResponse({ ok: true, reset: true });
    }

    return jsonResponse({ ok: false, error: "not_found" }, 404);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const stub = env.PPM_TICKS_COLLECTOR.getByName(
      collectorNameForFlavor("live"),
    );
    ctx.waitUntil(
      stub.ensureRunning("live").then((status) => {
        console.log(
          JSON.stringify({
            service: "ppm-live-ticks",
            message: "cron watchdog ensured collector running",
            connected: status.connected,
            subscribedEvents: status.subscribedEvents,
            ticksUnflushed: status.ticksUnflushed,
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>;
