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
import {
  LIVE_FILTER,
  SPORT_CATEGORIES,
  sportCategoryFor,
  summarizeCategories,
} from "../lib/sport_taxonomy.ts";
import {
  compactPositions,
  summarizeByGame,
  wagerTypeLabel,
} from "../lib/game_admin.ts";
import {
  findScore,
  readScoreboardFile,
  summarizeScoreboard,
  type ScoreboardFile,
} from "../lib/scoreboard.ts";
import {
  readPendingRows,
  summarizeAgents,
  summarizeGames,
  toLiveBetGame,
  type AgentScope,
  type LiveBetGame,
  type LiveBetsArtifact,
} from "../lib/live_bets.ts";
import { ReportingSchedulerService } from "./reporting_scheduler_service.ts";
import {
  REPORT_TYPES,
  SportsDeskTelegramService,
  isReportType,
  type TelegramUpdate,
} from "./sportsdesk_telegram_bot.ts";

/** `null` when the request comes from the same machine; otherwise the admin gate applies. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (address === null || address === undefined) return true; // unix socket = local
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "" || normalized === "localhost") return true;
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackAddress(normalized.slice("::ffff:".length));
  }
  return normalized.startsWith("127.");
}

/**
 * Guards endpoints that carry customer or agent-identifying data.
 *
 * Loopback is allowed so the local scoreboard keeps working without a token. Any other peer
 * must present `SPORTSDESK_ADMIN_TOKEN`: a phone on the same Wi-Fi must not be able to read
 * customer ids from a dev server bound to 0.0.0.0.
 */
function piiRejection(
  req: Request,
  address: string | null | undefined,
): { status: 401 | 403 | 503; error: string } | null {
  if (isLoopbackAddress(address)) return null;
  const gate = adminRejection(req);
  if (gate !== null) return gate;
  return null;
}

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

/** Reads the committed artifact first; falls back to the captured sample row. */
async function loadLiveBets(): Promise<{
  games: LiveBetGame[];
  agents: AgentScope;
  pendingCount: number;
  dataSource: string;
  capturedAt: string | null;
}> {
  const artifactFile = Bun.file(resolve(repoRoot, "data/live-bets.json"));
  if (await artifactFile.exists()) {
    const artifact = (await artifactFile.json()) as LiveBetsArtifact;
    return {
      games: [...artifact.games],
      agents: artifact.agents,
      pendingCount: artifact.pendingCount,
      dataSource: artifact.dataSource,
      capturedAt: artifact.capturedAt,
    };
  }

  const sampleFile = Bun.file(
    resolve(repoRoot, "tests/f402-pending-wager-sample.json"),
  );
  if (!(await sampleFile.exists())) {
    return {
      games: [],
      agents: summarizeAgents([]),
      pendingCount: 0,
      dataSource: "none",
      capturedAt: null,
    };
  }
  const pending = readPendingRows(await sampleFile.json());
  const games = pending.map((row) => toLiveBetGame(row));
  return {
    games,
    agents: summarizeAgents(games),
    pendingCount: pending.length,
    dataSource: "sample-fixture:tests/f402-pending-wager-sample.json",
    capturedAt: null,
  };
}

/** Portal scoreboard transcribed from the manager page; null when absent. */
async function loadScoreboard(): Promise<ScoreboardFile | null> {
  const file = Bun.file(resolve(repoRoot, "data/scoreboard.json"));
  if (!(await file.exists())) return null;
  return readScoreboardFile(await file.json());
}

/** Team-logo names come from the feed and may contain spaces (`"Arsenal FC.png"`).
 *  Validate by rejecting separators, control characters and traversal rather than by
 *  allowlisting characters the feed happens to use today. */
const LOGO_EXTENSION = /\.(?:png|jpe?g|gif|webp|svg)$/i;

function isLogoName(name: string): boolean {
  if (!LOGO_EXTENSION.test(name) || name.includes("..")) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || ch === "/" || ch === "\\") return false;
  }
  return true;
}

/** JSON files the generated graph page fetches relative to itself. */
const GRAPH_DOCS_JSON = new Set([
  "/combo-uniqueness.json",
  "/cross-domain-bridge.json",
]);

function isSafeAssetName(name: string): boolean {
  if (name === "" || name.includes("..")) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || ch === "\\") return false;
  }
  // Nested assets are allowed, but never outside docs/assets.
  return !name.startsWith("/");
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

      // Synthetic error trigger for testing error boundary.
      // Deliberately reachable in production: tests/server_error.test.ts asserts the
      // production 500 body carries no stack trace, so this hook must not be gated.
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

      // 2. Form-data parse debug (Blob.formData)
      if (pathname === "/api/parse-formdata" && req.method === "POST") {
        try {
          const MAX_FORM_BYTES = 1 << 20; // 1 MiB; unbounded arrayBuffer() is a memory DoS.
          const declared = Number(req.headers.get("content-length") ?? 0);
          if (declared > MAX_FORM_BYTES) {
            return Response.json(
              { error: `body exceeds ${MAX_FORM_BYTES} bytes` },
              { status: 413, headers: corsHeaders },
            );
          }
          const ct = req.headers.get("content-type") || "";
          const buf = await req.arrayBuffer();
          if (buf.byteLength > MAX_FORM_BYTES) {
            return Response.json(
              { error: `body exceeds ${MAX_FORM_BYTES} bytes` },
              { status: 413, headers: corsHeaders },
            );
          }
          const blob = new Blob([buf], { type: ct });
          const fd = await blob.formData();
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of fd.entries()) {
            if (out[k] === undefined) out[k] = String(v);
            else if (Array.isArray(out[k]))
              (out[k] as string[]).push(String(v));
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

      // 3. Live bets context, derived from real Report/Pending captures.
      // `/api/live-bets/summary` returns the same aggregates without the game list.
      if (
        pathname === "/api/live-bets" ||
        pathname === "/live-bets/summary" ||
        pathname === "/api/live-bets/summary"
      ) {
        const rejected = piiRejection(req, server.requestIP(req)?.address);
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: corsHeaders },
          );
        }

        const { games, agents, pendingCount, dataSource, capturedAt } =
          await loadLiveBets();
        const summary = summarizeGames(
          games,
          pendingCount,
          dataSource,
          capturedAt,
        );
        const generatedAt = new Date().toISOString();
        // A scoreboard is a snapshot; let the client decide when to re-ask.
        const headers = { ...corsHeaders, "Cache-Control": "no-store" };

        if (pathname.endsWith("/summary")) {
          return Response.json(
            { success: true, summary, generatedAt },
            { headers },
          );
        }

        // Scores come from the transcribed scoreboard; a wager without a matching game
        // stays null rather than borrowing a neighbour's score.
        const scoreboard = await loadScoreboard();
        const withScores = games.map((game) => ({
          ...game,
          position: wagerTypeLabel(game.wagerType),
          category: sportCategoryFor({
            sportType: game.sport,
            sportSubType: game.subSport,
          }),
          scoreboard:
            scoreboard === null
              ? null
              : findScore(scoreboard, {
                  team1: game.team1.name,
                  team2: game.team2.name,
                  league: game.subSport,
                }),
        }));

        const categories = summarizeCategories(
          withScores.map((game) => ({
            category: game.category,
            live: game.scoreboard?.status === "live",
          })),
        );

        return Response.json(
          {
            games: withScores,
            agents,
            pendingCount: summary.totalPending,
            summary,
            scoreboard:
              scoreboard === null
                ? null
                : {
                    source: scoreboard.source,
                    observedAt: scoreboard.observedAt,
                    summary: summarizeScoreboard(scoreboard),
                  },
            sports: {
              categories,
              all: SPORT_CATEGORIES,
              liveFilter: LIVE_FILTER,
            },
            generatedAt,
          },
          { headers },
        );
      }

      // 4. Logo proxy (fetches team logo and returns the image blob)
      if (pathname.startsWith("/api/logo/")) {
        const name = decodeURIComponent(pathname.slice("/api/logo/".length));
        if (!name) {
          return new Response("missing name", {
            status: 400,
            headers: corsHeaders,
          });
        }
        if (!isLogoName(name)) {
          return new Response("invalid logo name", {
            status: 400,
            headers: corsHeaders,
          });
        }
        try {
          const url = "https://cdn.fastassets.io/images/team-logos/" + name;
          const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
          if (!res.ok) {
            return new Response("not found", {
              status: res.status,
              headers: corsHeaders,
            });
          }
          const type = res.headers.get("content-type") ?? "";
          if (!type.startsWith("image/")) {
            return new Response("upstream did not return an image", {
              status: 502,
              headers: corsHeaders,
            });
          }
          const blob = await res.blob();
          return new Response(blob, {
            headers: {
              ...corsHeaders,
              "Content-Type": blob.type || "image/png",
              "Cache-Control": "public, max-age=86400, immutable",
            },
          });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 502, headers: corsHeaders },
          );
        }
      }

      // 5. Retired: /api/f402/get-pending answered the same dataset as /api/live-bets with a
      // different shape. Kept as an explicit tombstone so an old client fails loudly instead
      // of silently reading a fixture that looks live.
      if (pathname === "/api/f402/get-pending") {
        return Response.json(
          {
            success: false,
            error:
              "removed: use /api/live-bets (games + agents) or pass --body to build:live-bets",
          },
          { status: 410, headers: corsHeaders },
        );
      }

      // 6. Health & Telemetry Probe
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

      // 7. Live bets view
      if (pathname === "/live-bets") {
        return new Response(
          Bun.file(resolve(repoRoot, "static/live-bets.html")),
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "text/html; charset=utf-8",
            },
          },
        );
      }

      // 8. Executive Dashboard (GET / or GET /dashboard)
      if (pathname === "/" || pathname === "/dashboard") {
        return new Response(customerDashboardFile, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      // 9. Telegram Mini App (GET /miniapp)
      if (pathname === "/miniapp" || pathname === "/miniapp/") {
        return new Response(miniappDashboardFile, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      // 10. Dedicated Surveillance Graph & Shadow Portfolio Page (GET /graph or /graph.html)
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

      // 11. Graph data plane. `docs/graph.js` fetches these relative to the page, so the
      // daemon-served graph was dead (404) unless the docs directory was served separately.
      if (
        pathname === "/graph-live-feed.json" ||
        pathname === "/api/graph-feed"
      ) {
        return new Response(
          Bun.file(resolve(repoRoot, "docs/graph-live-feed.json")),
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      if (GRAPH_DOCS_JSON.has(pathname)) {
        return new Response(
          Bun.file(resolve(repoRoot, "docs", pathname.slice(1))),
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // "Action on a game", the Game Admin report the portal manual documents (F.A.Q. #4):
      // exposure per fixture with the Straight/Parlay/Teaser split.
      if (pathname === "/api/game-admin") {
        const { games } = await loadLiveBets();
        const lineup = summarizeByGame(games, new Date());
        return Response.json(
          {
            success: true,
            source: "live-bets wager capture",
            games: lineup.map((game) => ({
              ...game,
              positions: compactPositions(game.positions),
            })),
            generatedAt: new Date().toISOString(),
          },
          { headers: { ...corsHeaders, "Cache-Control": "no-store" } },
        );
      }

      // Portal sport taxonomy, with counts for whatever is currently loaded.
      if (pathname === "/api/sports") {
        const { games } = await loadLiveBets();
        const scoreboard = await loadScoreboard();
        const wagerRows = games.map((game) => ({
          category: sportCategoryFor({
            sportType: game.sport,
            sportSubType: game.subSport,
          }),
        }));
        const boardRows = (scoreboard?.games ?? []).map((game) => ({
          category: sportCategoryFor({ sportType: game.sport }),
          live: game.status === "live",
        }));

        return Response.json(
          {
            success: true,
            liveFilter: LIVE_FILTER,
            all: SPORT_CATEGORIES,
            wagers: summarizeCategories(wagerRows),
            scoreboard: summarizeCategories(boardRows),
          },
          { headers: { ...corsHeaders, "Cache-Control": "no-store" } },
        );
      }

      // Transcribed portal scoreboard (games + scores), separate from the wager capture.
      if (pathname === "/api/scoreboard") {
        const scoreboard = await loadScoreboard();
        if (scoreboard === null) {
          return Response.json(
            { error: "no scoreboard; add data/scoreboard.json" },
            { status: 404, headers: corsHeaders },
          );
        }
        return Response.json(
          { ...scoreboard, summary: summarizeScoreboard(scoreboard) },
          { headers: { ...corsHeaders, "Cache-Control": "no-store" } },
        );
      }

      // Agent forest, joined with the wager rollup so a tree node can show its own exposure.
      if (pathname === "/api/agent-tree") {
        const rejected = piiRejection(req, server.requestIP(req)?.address);
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: corsHeaders },
          );
        }
        const treeFile = Bun.file(resolve(repoRoot, "data/agent-tree.json"));
        if (!(await treeFile.exists())) {
          return Response.json(
            { error: "no agent tree; run bun run build:agent-tree" },
            { status: 404, headers: corsHeaders },
          );
        }
        const tree = (await treeFile.json()) as Record<string, unknown>;
        const { agents } = await loadLiveBets();
        const counts: Record<
          string,
          { games: number; wagered: number; toWin: number }
        > = {};
        for (const agent of agents.agents) {
          counts[agent.key] = {
            games: agent.games,
            wagered: agent.wagered,
            toWin: agent.toWin,
          };
        }
        return Response.json(
          { ...tree, counts },
          { headers: { ...corsHeaders, "Cache-Control": "no-store" } },
        );
      }

      if (pathname.startsWith("/assets/")) {
        const asset = pathname.slice("/assets/".length);
        if (!isSafeAssetName(asset)) {
          return new Response("invalid asset", {
            status: 400,
            headers: corsHeaders,
          });
        }
        const file = Bun.file(resolve(repoRoot, "docs/assets", asset));
        if (!(await file.exists())) {
          return new Response("not found", {
            status: 404,
            headers: corsHeaders,
          });
        }
        return new Response(file, {
          headers: { ...corsHeaders, "Cache-Control": "public, max-age=3600" },
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

      // 11. REST API: Monitored Watch List Accounts
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

      // 12. REST API: Instant Telegram Alert Dispatch
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

      // 13. REST API: Scheduled Executive Report Trigger
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

      // 14. 404 Fallback
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
