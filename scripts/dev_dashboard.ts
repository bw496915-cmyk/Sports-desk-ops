/**
 * @file scripts/dev_dashboard.ts
 * @description Native Bun-Powered Development Server for SportsDesk Dashboard.
 *
 * Implements:
 *  - Native React 18 bundling on the fly via Bun.build
 *  - Fast zero-copy file serving via Bun.file
 *  - Hot-reloading over native WebSockets for both React components and dashboard.md
 *  - Live Markdown-to-HTML rendering via Bun.markdown.html
 */

import { watch } from "node:fs";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { runBunBuild } from "./build.ts";
import {
  benchmarkResolverLatency,
  classifyIpAddress,
  getDnsTelemetry,
  prefetchSportsDeskEndpoints,
  SPORTSDESK_CORE_HOSTS,
} from "../lib/bun_dns.ts";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";
import {
  handleLogin,
  handleLogout,
  handleSessionMe,
  requireCsrf,
  requireSession,
} from "../lib/http_auth.ts";
import { AlertDispatcher } from "../lib/alerts.ts";

const PORT = Number(process.env.PORT) || 4022;
const DASHBOARD_MD_PATH = resolve(process.cwd(), "dashboard.md");
const DASHBOARD_ENTRY_PATH = resolve(process.cwd(), "src/dashboard/index.tsx");
const WAGER_TIERS_TOML_PATH = resolve(process.cwd(), "config/wager_tiers.toml");

const clients = new Set<ServerWebSocket<unknown>>();

// Initialize and start background surveillance alert dispatcher (5-second drain sweep)
const alertDispatcher = new AlertDispatcher({
  sweepIntervalMs: 5000,
});
alertDispatcher.start();

// Native memory pressure handler (Bun 1.4)
if (typeof process !== "undefined" && typeof process.on === "function") {
  try {
    process.on("memoryPressure", (level: string) => {
      console.warn(
        `[SportsDesk Dev Server] Host memory pressure: ${level}. Reclaiming build cache.`,
      );
    });
  } catch {
    // Unsupported environment fallback
  }
}

// Watch dashboard.md, src/dashboard, and config/wager_tiers.toml for live reloading
try {
  watch(DASHBOARD_MD_PATH, () => {
    // Publish to "dashboard" topic natively, plus legacy clients
    server.publish("dashboard", "dashboard-updated");
    for (const ws of clients) {
      if (
        !ws.subscriptions ||
        ws.subscriptions.length === 0 ||
        ws.subscriptions.includes("dashboard")
      ) {
        ws.send("dashboard-updated");
      }
    }
  });

  watch(resolve(process.cwd(), "src/dashboard"), { recursive: true }, () => {
    server.publish("dashboard", "reload");
    for (const ws of clients) {
      if (
        !ws.subscriptions ||
        ws.subscriptions.length === 0 ||
        ws.subscriptions.includes("dashboard")
      ) {
        ws.send("reload");
      }
    }
  });

  watch(WAGER_TIERS_TOML_PATH, async () => {
    try {
      const { reloadTomlConfigIfChanged } =
        await import("../lib/wager_config.ts");
      const { changed, config } = await reloadTomlConfigIfChanged();
      if (changed) {
        server.publish("tiers-updated", JSON.stringify(config));
        for (const ws of clients) {
          if (
            !ws.subscriptions ||
            ws.subscriptions.length === 0 ||
            ws.subscriptions.includes("tiers-updated") ||
            ws.subscriptions.includes("dashboard")
          ) {
            ws.send("tiers-updated");
          }
        }
      }
    } catch (err) {
      console.warn("File watch reload failed for wager_tiers.toml:", err);
    }
  });
} catch (err) {
  console.warn("File watch initialized with fallback:", err);
}

// Module-scope health check throttle state
let lastDbProbe = 0;
let lastSweep = 0;
let lastAlertProbe = 0;
const DB_PROBE_MS = 5_000;
const SWEEP_MS = 5 * 60_000;
const ALERT_PROBE_MS = 15_000;
let cachedDbStatus = "unconfigured";
let cachedAlertMetrics = alertDispatcher.getHealthMetrics();

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for hot reload
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Health check endpoint for operator & agent diagnostics (throttled to avoid DB/Disk DoS)
    if (url.pathname === "/health") {
      const now = Date.now();
      let purgedSessions = 0;

      if (process.env.PGUSER && process.env.PGPASSWORD) {
        if (now - lastDbProbe > DB_PROBE_MS) {
          lastDbProbe = now;
          try {
            const { sql } = await import("../lib/db.ts");
            await sql`SELECT 1`;
            cachedDbStatus = "connected";
          } catch (err) {
            cachedDbStatus = `error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        if (now - lastSweep > SWEEP_MS) {
          lastSweep = now;
          try {
            const { sessionCleanup } = await import("../lib/session.ts");
            purgedSessions = await sessionCleanup();
          } catch {
            // fire-and-forget, don't fail probe
          }
        }
      }

      if (now - lastAlertProbe > ALERT_PROBE_MS) {
        lastAlertProbe = now;
        cachedAlertMetrics = alertDispatcher.getHealthMetrics();
      }

      const overallStatus =
        cachedAlertMetrics.status === "degraded"
          ? "degraded"
          : cachedAlertMetrics.status === "warning"
            ? "warning"
            : "ok";

      return Response.json({
        status: overallStatus,
        service: "sportsdesk-dev-dashboard",
        port: PORT,
        bunVersion: Bun.version,
        uptimeSeconds: Math.floor(process.uptime()),
        db: cachedDbStatus,
        purgedSessions,
        alerts: cachedAlertMetrics,
        timestamp: new Date().toISOString(),
      });
    }

    // ── Auth Endpoints ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      return handleLogin(req, server);
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      return handleLogout(req);
    }
    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      return handleSessionMe(req);
    }

    // Fail-closed in production; opt-in in development
    const authRequired =
      process.env.NODE_ENV === "production"
        ? process.env.SPORTSDESK_AUTH_DISABLED !== "1"
        : process.env.SPORTSDESK_AUTH_REQUIRED === "1";

    if (
      authRequired &&
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/auth/")
    ) {
      const authRes = await requireSession(req, async () => new Response("OK"));
      if (authRes.status !== 200) {
        return authRes;
      }
      const csrfRes = await requireCsrf(req, async () => new Response("OK"));
      if (csrfRes.status !== 200) {
        return csrfRes;
      }
    }

    // API: Real-time dashboard data parsed via Bun.markdown.html
    if (url.pathname === "/api/dashboard") {
      const file = Bun.file(DASHBOARD_MD_PATH);
      if (!(await file.exists())) {
        return Response.json(
          { error: "dashboard.md not found" },
          { status: 404 },
        );
      }

      const markdown = await file.text();
      // trusted-markdown: local repo-owned dashboard.md rendered for operator dev server
      const html = Bun.markdown.html(markdown);
      return Response.json({
        markdown,
        html,
        updatedAt: new Date().toISOString(),
      });
    }

    // API: Real-time DNS Cache Telemetry
    if (url.pathname === "/api/dns") {
      const telemetry = getDnsTelemetry();
      return Response.json({
        telemetry,
        hosts: SPORTSDESK_CORE_HOSTS,
        updatedAt: new Date().toISOString(),
      });
    }

    // API: DNS Resolver Latency Benchmark
    if (url.pathname === "/api/dns/benchmark") {
      const host = url.searchParams.get("host") || "fantasy402.com";
      const result = await benchmarkResolverLatency(
        host,
        ["c-ares", "system"],
        3,
      );
      return Response.json(result);
    }

    // API: Reverse DNS & Forensics IP Classification
    if (url.pathname === "/api/dns/reverse") {
      const ip = url.searchParams.get("ip") || "1.1.1.1";
      const result = await classifyIpAddress(ip);
      return Response.json(result);
    }

    // API: Customer Profiling & Behavioral Sharp Showcase
    if (url.pathname === "/api/customers") {
      const backtestFile = Bun.file("docs/backtest-4wk-cfb-nba.json");
      const backtestJson = (await backtestFile.exists())
        ? ((await backtestFile.json()) as {
            customerLeaderboard?: Array<Record<string, unknown>>;
          })
        : { customerLeaderboard: [] };

      const fixtureFile = Bun.file(
        "tests/fixtures/backtest/enriched_customers_full.json",
      );
      const fixtureJson = (await fixtureFile.exists())
        ? ((await fixtureFile.json()) as Array<Record<string, unknown>>)
        : [];

      return Response.json({
        cohorts: {
          backtestCount: backtestJson.customerLeaderboard?.length ?? 49,
          keyNumberSharpsCount: 5,
          hookSyndicateCount: 5,
          fixtureCount: fixtureJson.length,
          fullBookSpecCount: 220,
          uniqueSurveillanceCount: 4914,
        },
        backtestTop: (backtestJson.customerLeaderboard ?? []).slice(0, 20),
        fixtures: fixtureJson,
      });
    }

    // API: PTY Terminal Emulator Execution powered by Bun.Terminal & Bun.spawn
    if (url.pathname === "/api/terminal/exec" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          command?: string;
          cols?: number;
          rows?: number;
        };
        const command = body.command?.trim() ?? "help";
        const result = await executeTerminalQuery(command, {
          cols: body.cols ?? 100,
          rows: body.rows ?? 30,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    // API: 30-Day Batched Player Rankings
    if (url.pathname === "/api/rankings/all") {
      try {
        const { runBatchedRanking } =
          await import("../lib/customer_rankings.ts");
        const limit = Number(url.searchParams.get("limit")) || 100;
        const data = await runBatchedRanking({ limitPlayers: limit });
        return Response.json(data);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    // API: Proxy Conduits
    if (url.pathname === "/api/agency/conduits") {
      try {
        const { runBatchedRanking } =
          await import("../lib/customer_rankings.ts");
        const data = await runBatchedRanking({ limitPlayers: 50 });
        const conduits = data.topSubAgents.filter((s) => s.isProxyConduit);
        return Response.json({ conduits });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    // API: Live Incoming Wager Feed & Surveillance Alerts
    if (url.pathname === "/api/wagers") {
      const wagers = [
        {
          ticketId: "W-109281",
          timestamp: "14:32:01 ET",
          customerId: "GP301",
          agentId: "AG99",
          masterAgent: "MASTER_VEND",
          sport: "NFL",
          betType: "Total",
          event: "Kansas City Chiefs @ Buffalo Bills",
          selection: "Under",
          lineDisplay: "47½",
          oddsAmerican: "-110",
          riskUsd: 5500,
          toWinUsd: 5000,
          clvCents: 14.2,
          alertTier: "CRITICAL",
          alertBadge: "🚨 CRITICAL (T1 Originator)",
          operatorDirective: "Clamp Max $250 (autoExecute: false)",
          maxRecommendedStake: 250,
          autoExecute: false,
        },
        {
          ticketId: "W-109282",
          timestamp: "14:32:15 ET",
          customerId: "CCC88412",
          agentId: "FATSNOBOT",
          masterAgent: "NOLAWOLF",
          sport: "CFB",
          betType: "Spread",
          event: "Georgia @ Texas",
          selection: "Texas",
          lineDisplay: "+3½",
          oddsAmerican: "-105",
          riskUsd: 5250,
          toWinUsd: 5000,
          clvCents: 11.5,
          alertTier: "STEAM",
          alertBadge: "🚨 STEAM (Key Number 3)",
          operatorDirective: "Clamp Max $250 (autoExecute: false)",
          maxRecommendedStake: 250,
          autoExecute: false,
        },
        {
          ticketId: "W-109283",
          timestamp: "14:32:44 ET",
          customerId: "BRT5235",
          agentId: "AG_SHARP",
          masterAgent: "MASTER_SYNDICATE",
          sport: "CFB",
          betType: "Spread",
          event: "Duke @ North Carolina",
          selection: "North Carolina",
          lineDisplay: "+7½",
          oddsAmerican: "-110",
          riskUsd: 3300,
          toWinUsd: 3000,
          clvCents: 9.8,
          alertTier: "STEAM",
          alertBadge: "🚨 STEAM (Hook Syndicate)",
          operatorDirective: "Clamp Max $250 (autoExecute: false)",
          maxRecommendedStake: 250,
          autoExecute: false,
        },
        {
          ticketId: "W-109284",
          timestamp: "14:33:02 ET",
          customerId: "MJ107",
          agentId: "MJ2026",
          masterAgent: "NOLAWOLF",
          sport: "CFB",
          betType: "Spread",
          event: "Ohio State @ Penn State",
          selection: "Ohio State",
          lineDisplay: "-3½",
          oddsAmerican: "-115",
          riskUsd: 4600,
          toWinUsd: 4000,
          clvCents: 8.4,
          alertTier: "STEAM",
          alertBadge: "⚡ STEAM (Line Mover)",
          operatorDirective: "Clamp Max $250 (autoExecute: false)",
          maxRecommendedStake: 250,
          autoExecute: false,
        },
        {
          ticketId: "W-109285",
          timestamp: "14:33:28 ET",
          customerId: "BGD101",
          agentId: "BIGDAD",
          masterAgent: "BIGDAD",
          sport: "NFL",
          betType: "Spread",
          event: "Baltimore Ravens @ Pittsburgh Steelers",
          selection: "Pittsburgh",
          lineDisplay: "+3½",
          oddsAmerican: "-110",
          riskUsd: 2200,
          toWinUsd: 2000,
          clvCents: 7.9,
          alertTier: "STEAM",
          alertBadge: "⚡ STEAM (Key Number 3)",
          operatorDirective: "Clamp Max $500 (autoExecute: false)",
          maxRecommendedStake: 500,
          autoExecute: false,
        },
        {
          ticketId: "W-109286",
          timestamp: "14:33:51 ET",
          customerId: "BAR301",
          agentId: "BAR01",
          masterAgent: "MASTER_SYNDICATE",
          sport: "NFL",
          betType: "Spread",
          event: "Detroit Lions @ Green Bay Packers",
          selection: "Detroit",
          lineDisplay: "-6½",
          oddsAmerican: "-110",
          riskUsd: 3300,
          toWinUsd: 3000,
          clvCents: 7.1,
          alertTier: "STEAM",
          alertBadge: "⚡ STEAM (Early Opener)",
          operatorDirective: "Clamp Max $500 (autoExecute: false)",
          maxRecommendedStake: 500,
          autoExecute: false,
        },
        {
          ticketId: "W-109287",
          timestamp: "14:34:10 ET",
          customerId: "KENT99",
          agentId: "KENT02",
          masterAgent: "MASTER_B",
          sport: "NBA",
          betType: "Total",
          event: "Boston Celtics @ Miami Heat",
          selection: "Miami Heat 2H",
          lineDisplay: "+4½",
          oddsAmerican: "-110",
          riskUsd: 2200,
          toWinUsd: 2000,
          clvCents: 6.8,
          alertTier: "LATENCY",
          alertBadge: "⚠️ LATENCY (Halftime)",
          operatorDirective: "Delay 3s + Cap $500 (autoExecute: false)",
          maxRecommendedStake: 500,
          autoExecute: false,
        },
        {
          ticketId: "W-109288",
          timestamp: "14:34:25 ET",
          customerId: "RF2003",
          agentId: "FAKEMONEY",
          masterAgent: "NOLAWOLF",
          sport: "SOCCER",
          betType: "Total",
          event: "Real Madrid vs Barcelona",
          selection: "Over",
          lineDisplay: "3½ Goals",
          oddsAmerican: "+130",
          riskUsd: 25000,
          toWinUsd: 32500,
          clvCents: -4.2,
          alertTier: "RECREATIONAL",
          alertBadge: "✅ RECREATIONAL (Whale)",
          operatorDirective: "Accept Normal ($25k) (autoExecute: false)",
          maxRecommendedStake: 25000,
          autoExecute: false,
        },
        {
          ticketId: "W-109289",
          timestamp: "14:34:42 ET",
          customerId: "LIVE99",
          agentId: "AG44",
          masterAgent: "MASTER_B",
          sport: "NBA",
          betType: "Moneyline",
          event: "Denver Nuggets @ LA Lakers",
          selection: "Lakers In-Play",
          lineDisplay: "ML",
          oddsAmerican: "+165",
          riskUsd: 1500,
          toWinUsd: 2475,
          clvCents: 5.4,
          alertTier: "LATENCY",
          alertBadge: "⚠️ LATENCY (In-Play)",
          operatorDirective: "Delay 3s + Cap $1,000 (autoExecute: false)",
          maxRecommendedStake: 1000,
          autoExecute: false,
        },
        {
          ticketId: "W-109290",
          timestamp: "14:35:05 ET",
          customerId: "SQUARE1",
          agentId: "AG05",
          masterAgent: "MASTER_RETAIL",
          sport: "CFB",
          betType: "Parlay",
          event: "4-Leg CFB Parlay",
          selection: "MIA -7 / TEX -3 / OSU -3 / ORE -14",
          lineDisplay: "4-Leg",
          oddsAmerican: "+1100",
          riskUsd: 1000,
          toWinUsd: 11000,
          clvCents: -12.5,
          alertTier: "RECREATIONAL",
          alertBadge: "✅ RECREATIONAL (Square Parlay)",
          operatorDirective: "Accept Normal ($25k) (autoExecute: false)",
          maxRecommendedStake: 25000,
          autoExecute: false,
        },
        {
          ticketId: "W-109291",
          timestamp: "14:35:30 ET",
          customerId: "BRT5229",
          agentId: "AG_SHARP",
          masterAgent: "MASTER_SYNDICATE",
          sport: "NFL",
          betType: "Spread",
          event: "Philadelphia Eagles @ Dallas Cowboys",
          selection: "Philadelphia",
          lineDisplay: "-3½",
          oddsAmerican: "-110",
          riskUsd: 5000,
          toWinUsd: 4545,
          clvCents: 12.1,
          alertTier: "CRITICAL",
          alertBadge: "🚨 CRITICAL (Steam Root)",
          operatorDirective: "Clamp Max $250 (autoExecute: false)",
          maxRecommendedStake: 250,
          autoExecute: false,
        },
        {
          ticketId: "W-109292",
          timestamp: "14:35:55 ET",
          customerId: "BK119",
          agentId: "AG81",
          masterAgent: "MASTER_C",
          sport: "CFB",
          betType: "Total",
          event: "Michigan @ Michigan State",
          selection: "2H Under",
          lineDisplay: "21½",
          oddsAmerican: "-105",
          riskUsd: 800,
          toWinUsd: 762,
          clvCents: 3.2,
          alertTier: "STEAM",
          alertBadge: "⚡ SEMI-SHARP (2H Total)",
          operatorDirective: "Cap Max $2,500 (autoExecute: false)",
          maxRecommendedStake: 2500,
          autoExecute: false,
        },
      ];

      return Response.json({
        wagers,
        totalRiskUsd: wagers.reduce((sum, w) => sum + w.riskUsd, 0),
        totalToWinUsd: wagers.reduce((sum, w) => sum + w.toWinUsd, 0),
        criticalSteamCount: wagers.filter(
          (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
        ).length,
        autoExecute: false,
        timestamp: new Date().toISOString(),
      });
    }

    // API: Wager Tiers and Surveillance TOML Configuration (Bun.TOML)
    if (url.pathname === "/api/config/tiers") {
      try {
        const { loadTomlConfig } = await import("../lib/wager_config.ts");
        const config = await loadTomlConfig();
        return Response.json(config);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    // API: Surveillance Alert Queue Drain Sweep Trigger
    if (url.pathname === "/api/alerts/sweep" && req.method === "POST") {
      const sweep = await alertDispatcher.sweepOnce();
      return Response.json({ ok: true, sweep });
    }

    // API: Surveillance Alerts Query (DLQ, queued, delivered, acknowledged, all)
    if (url.pathname === "/api/alerts" && req.method === "GET") {
      const statusParam = (
        url.searchParams.get("status") ?? "all"
      ).toLowerCase();
      const { listAlerts } = await import("../lib/alerts.ts");
      const alerts = listAlerts(statusParam);
      return Response.json({
        alerts,
        total: alerts.length,
        status: statusParam,
        timestamp: new Date().toISOString(),
      });
    }

    // API: Acknowledge Alert (Operator action to clear dead alert or active alert)
    const ackMatch = url.pathname.match(/^\/api\/alerts\/([^/]+)\/ack$/);
    if (ackMatch && req.method === "POST") {
      const deliveryId = ackMatch[1]!;
      let body: { operatorId?: string; notes?: string } = {};
      try {
        body = (await req.json()) as { operatorId?: string; notes?: string };
      } catch {
        // empty body is acceptable
      }
      const { acknowledgeAlert } = await import("../lib/alerts.ts");
      const ok = await acknowledgeAlert({
        deliveryId,
        operatorId: body.operatorId ?? "operator",
        notes: body.notes,
      });
      return Response.json({ ok, deliveryId });
    }

    // API: Replay from DLQ (Operator action to retry dead-lettered alert)
    const retryMatch = url.pathname.match(/^\/api\/alerts\/([^/]+)\/retry$/);
    if (retryMatch && req.method === "POST") {
      const deliveryId = retryMatch[1]!;
      let body: { operatorId?: string } = {};
      try {
        body = (await req.json()) as { operatorId?: string };
      } catch {
        // empty body is acceptable
      }
      const { retryAlert } = await import("../lib/alerts.ts");
      const newDeliveryId = await retryAlert({
        deliveryId,
        operatorId: body.operatorId ?? "operator",
      });
      if (!newDeliveryId) {
        return Response.json(
          { error: "Alert not found in dead-letter state" },
          { status: 404 },
        );
      }
      return Response.json({
        ok: true,
        originalDeliveryId: deliveryId,
        newDeliveryId,
      });
    }

    // API: Shift Summary (Shift handoff aggregation of alerts, queries, and auth)
    if (url.pathname === "/api/shift/summary" && req.method === "GET") {
      const operatorId = url.searchParams.get("operatorId") ?? "operator";
      const { getShiftSummary } = await import("../lib/alerts.ts");
      const summary = getShiftSummary(operatorId);
      return Response.json(summary);
    }

    // API: WebSocket Status & Topic Subscriptions Telemetry (ServerWebSocket.subscriptions)
    if (url.pathname === "/api/ws/status") {
      const topicCounts: Record<string, number> = {};
      const clientSummaries: Array<{ id: number; topics: string[] }> = [];
      let clientId = 1;

      for (const ws of clients) {
        const subs = ws.subscriptions ?? [];
        clientSummaries.push({ id: clientId++, topics: subs });
        for (const topic of subs) {
          topicCounts[topic] = (topicCounts[topic] || 0) + 1;
        }
      }

      return Response.json({
        totalConnectedClients: clients.size,
        topicDistribution: topicCounts,
        clients: clientSummaries,
        serverTopics: [
          "dashboard",
          "live-bets",
          "syndicate-alerts",
          "tiers-updated",
          "proxy-conduits",
          "terminal-logs",
        ],
        timestamp: new Date().toISOString(),
      });
    }

    // Dynamic React bundle compiled on the fly via Bun.build
    if (url.pathname === "/index.js") {
      const build = await runBunBuild({
        entrypoints: [DASHBOARD_ENTRY_PATH],
        target: "browser",
        sourcemap: "inline",
      });

      if (!build.success || build.outputs.length === 0) {
        console.error("Build failed:", build.logs);
        return new Response("console.error('Bundle compilation failed');", {
          status: 500,
          headers: { "Content-Type": "application/javascript" },
        });
      }

      const output = build.outputs[0];
      if (!output) {
        return new Response("Missing output", { status: 500 });
      }
      return new Response(await output.text(), {
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache",
        },
      });
    }

    // Root SPA Shell
    if (url.pathname === "/" || !url.pathname.includes(".")) {
      const htmlShell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SportsDesk &amp; Fantasy402 Real-Time Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #070b14;
        --card: #0d1527;
        --border: #1e293b;
        --text: #f1f5f9;
        --muted: #94a3b8;
        --accent: #38bdf8;
      }
      body {
        margin: 0;
        background-color: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 16px 0;
        font-size: 14px;
      }
      th, td {
        padding: 10px 14px;
        border: 1px solid var(--border);
        text-align: left;
      }
      th {
        background-color: var(--card);
        color: var(--muted);
        text-transform: uppercase;
        font-size: 12px;
      }
      tr:nth-child(even) td {
        background-color: rgba(30, 41, 59, 0.4);
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #f59e0b;
        background: rgba(30, 41, 59, 0.6);
        padding: 2px 6px;
        border-radius: 4px;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      blockquote {
        margin: 12px 0;
        padding: 8px 16px;
        border-left: 4px solid var(--accent);
        background: rgba(13, 21, 39, 0.7);
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/index.js"></script>
  </body>
</html>`;
      return new Response(htmlShell, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      // Automatically subscribe to base dashboard broadcast channel
      ws.subscribe("dashboard");
    },
    close(ws) {
      clients.delete(ws);
    },
    message(ws, message) {
      try {
        const text =
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message);
        const data = JSON.parse(text) as {
          type?: string;
          topic?: string;
          topics?: string[];
        };

        if (data.type === "subscribe" && data.topic) {
          ws.subscribe(data.topic);
          ws.send(
            JSON.stringify({
              type: "subscribed",
              topic: data.topic,
              activeTopics: ws.subscriptions,
            }),
          );
        } else if (
          data.type === "subscribe-all" ||
          (data.type === "subscribe" && data.topics)
        ) {
          const list = data.topics ?? [
            "dashboard",
            "live-bets",
            "syndicate-alerts",
            "tiers-updated",
            "proxy-conduits",
            "terminal-logs",
          ];
          for (const t of list) ws.subscribe(t);
          ws.send(
            JSON.stringify({
              type: "subscribed-many",
              topics: list,
              activeTopics: ws.subscriptions,
            }),
          );
        } else if (data.type === "unsubscribe" && data.topic) {
          ws.unsubscribe(data.topic);
          ws.send(
            JSON.stringify({
              type: "unsubscribed",
              topic: data.topic,
              activeTopics: ws.subscriptions,
            }),
          );
        } else if (data.type === "query-subscriptions") {
          ws.send(
            JSON.stringify({
              type: "subscriptions",
              activeTopics: ws.subscriptions,
            }),
          );
        }
      } catch {
        // Plain string or ping/pong fallback
      }
    },
  },
});

// Pre-warm DNS cache for all sportsdesk service endpoints
const warmedHosts = prefetchSportsDeskEndpoints();

console.log(
  `\n🚀 SportsDesk Dashboard Dev Server listening at http://localhost:${server.port}`,
);
console.log(
  `🌐 Pre-warmed DNS cache for ${warmedHosts} core endpoints via Bun.dns.prefetch()`,
);
console.log(
  `🔔 In-flight surveillance alert dispatcher active (5s background sweep)`,
);
console.log(
  `⚡ Hot-reloading active on React components (src/dashboard/) and dashboard.md\n`,
);
