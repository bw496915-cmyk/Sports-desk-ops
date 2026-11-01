#!/usr/bin/env bun
/**
 * @file sportsdesk_webview_server.ts
 * @description Native Bun (v1.4+) Webview Automation Server & Telegram Mini App Gateway.
 *
 * Implements native Bun HTTP server semantics:
 *  - Native port cascade: relies on Bun's BUN_PORT -> PORT -> NODE_PORT -> 3000 cascade
 *    (SportsDesk defaults to PORT=4020 via auto-loaded .env, overridable via options).
 *  - Explicit or default hostname binding (defaults to 0.0.0.0).
 *  - Unix domain socket support via `unix` option or `BUN_SOCKET` environment variable
 *    (removes TCP port exposure for local Nginx upstream proxying).
 *  - High-throughput Response.json() and lazy Response(Bun.file()) static file handle serving.
 *  - Standardized CORS and CSP frame-ancestors for Telegram Mini App embedding (no X-Frame-Options).
 *  - Robust error boundary handling via Bun.serve `error(err)` returning structured 500 JSON.
 */

import crypto from "node:crypto";
import { resolve, dirname } from "node:path";
import { ReportingSchedulerService } from "./reporting_scheduler_service.ts";
import {
  REPORT_TYPES,
  SportsDeskTelegramService,
  isReportType,
  type TelegramUpdate,
} from "./sportsdesk_telegram_bot.ts";

/** `null` when the bearer token matches SPORTSDESK_ADMIN_TOKEN; otherwise the rejection status and reason. */
function adminRejection(
  req: Request,
): { status: 401 | 503; error: string } | null {
  const expected = Bun.env.SPORTSDESK_ADMIN_TOKEN ?? "";
  if (!expected) {
    return {
      status: 503,
      error: "SPORTSDESK_ADMIN_TOKEN is not set on the server",
    };
  }
  const given = (req.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b)
    ? null
    : { status: 401, error: "Missing or wrong admin token" };
}

const repoRoot = resolve(
  typeof import.meta !== "undefined" && import.meta.dir
    ? import.meta.dir
    : dirname(process.argv[1] || "."),
  "..",
);

export interface ServerOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly unix?: string;
  readonly development?: boolean;
}

export function startServer(options?: ServerOptions) {
  const telegramService = new SportsDeskTelegramService();
  const scheduler = new ReportingSchedulerService(telegramService);
  const customerDashboardPath = resolve(
    repoRoot,
    "static/customer-churn-simulation-dashboard.html",
  );
  const miniappDashboardPath = resolve(
    repoRoot,
    "static/telegram-miniapp-dashboard.html",
  );

  const customerDashboardFile = Bun.file(customerDashboardPath);
  const miniappDashboardFile = Bun.file(miniappDashboardPath);

  const isDevelopment =
    options?.development ??
    (typeof Bun !== "undefined"
      ? Bun.env.NODE_ENV !== "production"
      : process.env.NODE_ENV !== "production");

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, X-Telegram-Bot-Api-Secret-Token",
    "Content-Security-Policy":
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };

  const serveConfig: Parameters<typeof Bun.serve>[0] = {
    development: isDevelopment,

    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // Synthetic error trigger for testing error boundary
      if (
        pathname === "/api/test/error" ||
        url.searchParams.get("trigger_error") === "non_error"
      ) {
        throw "Synthetic non-Error thrown in handler";
      }

      // 1. Fast Preflight OPTIONS Response (HTTP 204 No Content)
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // 2a. Form-data parse debug (Blob.formData)
      if (pathname === "/api/parse-formdata" && req.method === "POST") {
        try {
          const ct = req.headers.get("content-type") || "";
          const buf = await req.arrayBuffer();
          const blob = new Blob([buf], { type: ct });
          const fd = await blob.formData();
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of fd.entries()) {
            if (out[k] === undefined) out[k] = String(v);
            else if (Array.isArray(out[k])) (out[k] as string[]).push(String(v));
            else out[k] = [out[k] as string, String(v)];
          }
          return Response.json(out, { headers: corsHeaders });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 400, headers: corsHeaders },
          );
        }
      }

      // 2b. Live bets context (mock shape until wired to real feed)
      if (pathname === "/api/live-bets") {
        return Response.json(
          {
            games: [
              {
                ticketNumber: 1073351436,
                agentID: "HRGROUP",
                customerID: "CC364",
                key: "NFL-244-Arizona‡Cardinals-Dallas‡Cowboys",
                status: "P",
                quarter: "2nd Half",
                wagered: 22400000,
                toWin: 20000000,
                home: { team: "Cardinals", score: 0, logo: "Arizona-Cardinals.png", logoUrl: "https://cdn.fastassets.io/images/team-logos/Arizona-Cardinals.png" },
                away: { team: "Cowboys", score: 0, logo: "Dallas-Cowboys.png", logoUrl: "https://cdn.fastassets.io/images/team-logos/Dallas-Cowboys.png" },
              },
              {
                ticketNumber: 1073270123,
                agentID: "VIPMIAMI",
                customerID: "VIPM126",
                key: "NFL-241-Las‡Vegas‡Raiders-New‡York‡Jets",
                status: "P",
                quarter: "Game",
                wagered: 15750000,
                toWin: 15000000,
                home: { team: "Raiders", score: 0, logo: "Oakland-Raiders.png", logoUrl: "https://cdn.fastassets.io/images/team-logos/Oakland-Raiders.png" },
                away: { team: "Jets", score: 0, logo: "New-York-Jets.png", logoUrl: "https://cdn.fastassets.io/images/team-logos/New-York-Jets.png" },
              },
              {
                ticketNumber: 1073270123,
                agentID: "VIPMIAMI",
                customerID: "VIPM126",
                key: "NFL-248-Buffalo‡Bills-Baltimore‡Ravens",
                status: "P",
                quarter: "Game",
                wagered: 16500000,
                toWin: 15000000,
                home: { team: "Ravens", score: 0, logo: "Baltimore-Ravens.png", logoUrl: "https://cdn.fastassets.io/images/team-logos/Baltimore-Ravens.png" },
                away: { team: "Bills", score: 0, logo: "Buffalo-Bills.png", logoUrl: "https://cdn.fastassets.io/images/team-logos/Buffalo-Bills.png" },
              },
              {
                ticketNumber: 1073270123,
                agentID: "VIPMIAMI",
                customerID: "VIPM126",
                key: "NFL-240-Detroit‡Lions-Minnesota‡Vikings",
                status: "P",
                quarter: "Game",
                wagered: 9000000,
                toWin: 7500000,
                home: { team: "Vikings", score: 0, logo: "Minnesota-Vikings.png", logoUrl: "https://cdn.fastassets.io/images/team-logos/Minnesota-Vikings.png" },
                away: { team: "Lions", score: 0, logo: "Detroit-Lions.png", logoUrl: "https://cdn.fastassets.io/images/team-logos/Detroit-Lions.png" },
              },
            ],
            generatedAt: new Date().toISOString(),
          },
          { headers: corsHeaders },
        );
      }

      // 2c. Logo proxy (fetches team logo and returns the image blob)
      if (pathname.startsWith("/api/logo/")) {
        const name = decodeURIComponent(pathname.slice("/api/logo/".length));
        if (!name) {
          return new Response("missing name", { status: 400, headers: corsHeaders });
        }
        try {
          const url = "https://cdn.fastassets.io/images/team-logos/" + name;
          const res = await fetch(url);
          if (!res.ok) {
            return new Response("not found", { status: res.status, headers: corsHeaders });
          }
          const blob = await res.blob();
          return new Response(blob, {
            headers: { ...corsHeaders, "Content-Type": blob.type || "image/png" },
          });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 502, headers: corsHeaders });
        }
      }

      // 2. Health & Telemetry Probe
      if (pathname === "/health") {
        return Response.json(
          {
            status: "healthy",
            port: server.port,
            hostname: server.hostname,
            url: server.url ? server.url.toString() : "unix://socket",
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
            runtime: `Bun v${Bun.version} (${process.arch}-${process.platform})`,
            nodeEnv:
              (typeof Bun !== "undefined"
                ? Bun.env.NODE_ENV
                : process.env.NODE_ENV) || "development",
          },
          { headers: corsHeaders },
        );
      }

      // 3. Executive Dashboard (GET / or GET /dashboard)
      if (pathname === "/" || pathname === "/dashboard") {
        return new Response(customerDashboardFile, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      // 4. Telegram Mini App (GET /miniapp)
      if (pathname === "/miniapp" || pathname === "/miniapp/") {
        return new Response(miniappDashboardFile, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      // 4b. Dedicated Surveillance Graph & Shadow Portfolio Page (GET /graph or /graph.html)
      if (
        pathname === "/graph" ||
        pathname === "/graph/" ||
        pathname === "/graph.html" ||
        pathname === "/surveillance-graph"
      ) {
        return new Response(Bun.file(resolve(repoRoot, "docs/graph.html")), {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      if (pathname === "/graph.js") {
        return new Response(Bun.file(resolve(repoRoot, "docs/graph.js")), {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/javascript; charset=utf-8",
          },
        });
      }

      // Telegram webhook: Telegram echoes the secret registered by setWebhook in this header
      if (pathname === "/telegram/webhook" && req.method === "POST") {
        if (
          !telegramService.isWebhookSecretValid(
            req.headers.get("x-telegram-bot-api-secret-token"),
          )
        ) {
          return Response.json({ ok: false }, { status: 401 });
        }
        const update = (await req
          .json()
          .catch(() => null)) as TelegramUpdate | null;
        if (update) {
          await telegramService
            .handleUpdate(update)
            .catch((err) =>
              console.error("[Telegram webhook] update failed:", err),
            );
        }
        return Response.json({ ok: true });
      }

      if (
        pathname === "/api/watchlist" ||
        pathname.startsWith("/api/telegram/")
      ) {
        const rejected = adminRejection(req);
        if (rejected) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: corsHeaders },
          );
        }
      }

      if (pathname === "/api/telegram/status" && req.method === "GET") {
        return Response.json(
          {
            success: true,
            status: await telegramService.getStatus(),
            schedules: scheduler.getSchedules(),
            reportTypes: REPORT_TYPES,
          },
          { headers: corsHeaders },
        );
      }

      if (pathname === "/api/telegram/activity" && req.method === "GET") {
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit")) || 50, 1),
          200,
        );
        return Response.json(
          { success: true, entries: await telegramService.getActivity(limit) },
          { headers: corsHeaders },
        );
      }

      if (pathname === "/api/telegram/webhook" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          action?: string;
        };
        if (body.action !== "set" && body.action !== "delete") {
          return Response.json(
            { success: false, error: 'action must be "set" or "delete"' },
            { status: 400, headers: corsHeaders },
          );
        }
        const res =
          body.action === "set"
            ? await telegramService.setWebhook()
            : await telegramService.deleteWebhook();
        return Response.json(
          {
            success: res.ok,
            ok: res.ok,
            error: res.ok ? undefined : res.description,
          },
          { status: res.ok ? 200 : 502, headers: corsHeaders },
        );
      }

      // 5. REST API: Monitored Watch List Accounts
      if (pathname === "/api/watchlist") {
        const list = Array.from(telegramService.getWatchList().values());
        return Response.json(
          {
            success: true,
            count: list.length,
            data: list,
          },
          { headers: corsHeaders },
        );
      }

      // 6. REST API: Instant Telegram Alert Dispatch
      if (pathname === "/api/telegram/alert" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            customerId?: string;
          };
          const custId = body.customerId || "RF2003";
          const sent = await telegramService.dispatchTestAlert(custId);
          return Response.json(
            {
              success: true,
              ok: sent,
              customerId: custId,
            },
            { headers: corsHeaders },
          );
        } catch (err: any) {
          return Response.json(
            {
              success: false,
              ok: false,
              error: err?.message || String(err),
            },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      // 7. REST API: Scheduled Executive Report Trigger
      if (pathname === "/api/telegram/report" && req.method === "POST") {
        const type = url.searchParams.get("type") || "EVENING_SETTLEMENT";
        if (!isReportType(type)) {
          return Response.json(
            {
              success: false,
              error: `type must be one of ${REPORT_TYPES.join(", ")}`,
            },
            { status: 400, headers: corsHeaders },
          );
        }
        const sent = await scheduler.dispatchReportNow(type);
        return Response.json(
          {
            success: true,
            ok: sent,
            reportType: type,
          },
          { headers: corsHeaders },
        );
      }

      // 8. 404 Fallback
      return Response.json(
        {
          success: false,
          error: "Not Found",
          pathname,
        },
        { status: 404, headers: corsHeaders },
      );
    },

    error(err) {
      console.error("[SportsDesk Server Error]", err);
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "An unexpected error occurred";

      return Response.json(
        {
          success: false,
          error: "Internal Server Error",
          message,
        },
        { status: 500, headers: corsHeaders },
      );
    },
  };

  const unixSocket =
    options?.unix ||
    (typeof Bun !== "undefined" ? Bun.env.BUN_SOCKET : process.env.BUN_SOCKET);

  if (unixSocket) {
    (serveConfig as any).unix = unixSocket;
  } else {
    if (options?.port !== undefined) {
      serveConfig.port = options.port;
    }
    if (options?.hostname !== undefined) {
      serveConfig.hostname = options.hostname;
    }
  }

  const server = Bun.serve(serveConfig);
  return server;
}

if (import.meta.main) {
  const server = startServer();
  const location = server.url ? server.url.toString() : "unix domain socket";
  console.log(`[SportsDesk Webview Server] Active on ${location}`);
  console.log(` • Master Dashboard : ${location}`);
  console.log(` • Mini App (TMA)   : ${location}miniapp`);
  console.log(` • Health Probe     : ${location}health`);
  console.log(` • Watch List API   : ${location}api/watchlist`);
}
