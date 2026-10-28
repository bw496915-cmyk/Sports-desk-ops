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

import { resolve, dirname } from "node:path";
import { SportsDeskTelegramService } from "./sportsdesk_telegram_bot.ts";

const currentDir =
  typeof import.meta !== "undefined" && import.meta.dir
    ? import.meta.dir
    : dirname(process.argv[1] || ".");

export interface ServerOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly unix?: string;
  readonly development?: boolean;
}

export function startServer(options?: ServerOptions) {
  const telegramService = new SportsDeskTelegramService();
  const customerDashboardPath = resolve(
    currentDir,
    "customer-churn-simulation-dashboard.html",
  );
  const miniappDashboardPath = resolve(
    currentDir,
    "telegram-miniapp-dashboard.html",
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
      if (pathname === "/miniapp") {
        return new Response(miniappDashboardFile, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
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
        const type = (url.searchParams.get("type") ||
          "EVENING_SETTLEMENT") as any;
        const sent = await telegramService.dispatchScheduledReport(type);
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
    (typeof Bun !== "undefined"
      ? Bun.env.BUN_SOCKET
      : process.env.BUN_SOCKET);

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
