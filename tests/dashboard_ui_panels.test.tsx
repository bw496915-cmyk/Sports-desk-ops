import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../packages/ui/src/App.tsx";
import { renderAnsiReact } from "../packages/ui/src/ansi.tsx";
import {
  AlertsTabPanel,
  BetTickerTabPanel,
  BuildMatrixDrawer,
  CustomersTabPanel,
  LiveWagersTabPanel,
  R2PipelineTabPanel,
  RankingsTabPanel,
  ShiftHandoffModal,
  SurveillanceTabPanel,
  TerminalTabPanel,
} from "../packages/ui/src/panels/index.tsx";
import {
  PROXY_CONDUITS_30D,
  SAMPLE_LIVE_WAGERS,
  SAMPLE_PROFILE_DATA,
  TERMINAL_WELCOME_HELP_STDOUT,
} from "../packages/ui/src/showcase_data.ts";

describe("@sportsdesk-ops/ui modular App & panels (renderToStaticMarkup)", () => {
  test("App renders orchestrator header, tabs, and customer panel without runtime error", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("SportsDesk &amp; Fantasy402 Operations");
    expect(html).toContain("autoExecute: false");
    expect(html).toContain(`Profiles (${SAMPLE_PROFILE_DATA.length})`);
    expect(html).toContain(`Downlines (${PROXY_CONDUITS_30D.length})`);
    expect(html).toContain(`Live Wagers (${SAMPLE_LIVE_WAGERS.length})`);
    expect(html).toContain("GP301");
  });

  test("BuildMatrixDrawer renders sentinel, token swatches, and target table", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuildMatrixDrawer, {
        dceMarker: "[DCE_UNBUNDLED_HMR]",
        loading: false,
        rows: [
          {
            target: "prod",
            features: ["PROD"],
            totalJsBytes: 40960,
            totalCssBytes: 8192,
            hasDebugSentinel: false,
            hasExperimentalSentinel: false,
            hasProdSentinel: true,
          },
        ],
      }),
    );
    expect(html).toContain("[DCE_UNBUNDLED_HMR]");
    expect(html).toContain("Obsidian: --sd-surface-bg");
    expect(html).toContain("40.0 KB");
    expect(html).toContain("✅ Kept");
    expect(html).toContain("✂️ Pruned (DCE)");
  });

  test("CustomersTabPanel renders customer table, radars, and inspector actions", () => {
    const cust = SAMPLE_PROFILE_DATA[0]!;
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: false,
        onDismissBanner: noop,
        kpisCollapsed: false,
        onToggleKpis: noop,
        searchQuery: "",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: SAMPLE_PROFILE_DATA,
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: cust,
        onSelectCustomer: noop,
        copiedCliId: null,
        onCopyCli: noop,
        customerForensicResult: "Datacenter check clean",
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
      }),
    );
    expect(html).toContain(`Profiled Bettors (${SAMPLE_PROFILE_DATA.length})`);
    expect(html).toContain("Pending…");
    expect(html).not.toContain("49 Accounts");
    expect(html).not.toContain("4,914 IDs");
    expect(html).toContain("Decomposed Sharpness Radars");
    expect(html).toContain("Golden Punter Syndicate Seat 1");
    expect(html).toContain("Datacenter check clean");
  });

  test("SurveillanceTabPanel renders DNS telemetry, benchmark controls, and markdown/html view", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(SurveillanceTabPanel, {
        dnsData: {
          telemetry: {
            size: 4,
            hitRatePercent: 98.5,
            cacheHitsCompleted: 120,
            cacheHitsInflight: 3,
            cacheMisses: 2,
            defaultTtlSeconds: 30,
          },
        },
        benchLoading: false,
        benchResult: "c-ares: 1.2ms",
        onRunBenchmark: noop,
        reverseIp: "1.1.1.1",
        onReverseIpChange: noop,
        reverseResult: "Cloudflare",
        onRunReverseLookup: noop,
        viewMode: "raw",
        onViewModeChange: noop,
        data: {
          markdown: "# Live Desk Status",
          html: "<h1>Live Desk Status</h1>",
          updatedAt: "2026-11-12T00:00:00Z",
        },
      }),
    );
    expect(html).toContain("98.5%");
    expect(html).toContain("c-ares: 1.2ms");
    expect(html).toContain("# Live Desk Status");
  });

  test("TerminalTabPanel renders PTY window, quick chips, and ANSI history", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(TerminalTabPanel, {
        terminalCategory: "ALL",
        onTerminalCategoryChange: noop,
        terminalHistory: [
          {
            command: "help",
            stdout: TERMINAL_WELCOME_HELP_STDOUT,
            exitCode: 0,
            durationMs: 2,
            timestamp: 1700000000000,
          },
        ],
        onClearHistory: noop,
        copiedTerminalIdx: null,
        onCopyOutput: noop,
        terminalLoading: false,
        terminalBottomRef: { current: null },
        terminalCommand: "p GP301",
        onTerminalCommandChange: noop,
        commandHistory: ["help"],
        historyIndex: -1,
        onHistoryIndexChange: noop,
        onAutocomplete: noop,
        onRunCommand: noop,
      }),
    );
    expect(html).toContain("PTY Engine Ready");
    expect(html).toContain(
      "SPORTSDESK &amp; FANTASY402 INTERACTIVE PTY TERMINAL",
    );
    expect(html).toContain("Run (PTY)");
  });

  test("RankingsTabPanel renders 30d rankings and agency proxy conduits", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: noop,
        rankingsFilter: "ALL",
        onRankingsFilterChange: noop,
        onInspectPty: noop,
      }),
    );
    expect(html).toContain("30-Day Sharp Bettor Rankings");
    expect(html).toContain("FAKEMONEY");
    expect(html).toContain("SINGLE BETTOR PROXY CONDUIT");
  });

  test("AlertsTabPanel renders DLQ KPIs, toast, and alert action buttons", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(AlertsTabPanel, {
        alertToast: { message: "Queue Swept: 1 sent", type: "info" },
        onDismissToast: noop,
        onCopyDeliveryId: noop,
        healthData: {
          status: "degraded",
          uptimeSeconds: 42,
          alerts: {
            status: "degraded",
            queued: 1,
            delivered: 3,
            dead: 1,
            backlog: 1,
            acknowledged: 2,
          },
        },
        alertFilter: "ALL",
        onFilterChange: noop,
        alertLoading: false,
        onSweepAlerts: noop,
        onRefreshAlerts: noop,
        onOpenShiftModal: noop,
        alertRecords: [
          {
            deliveryId: "dead-uuid-12345678",
            wagerId: "W-109281",
            tier: "CRITICAL",
            status: "dead",
            payload: {
              customerId: "GP301",
              amountUsd: 5500,
              clvCents: 14.2,
              directive: "Clamp Max $250",
            },
            createdAt: "2026-11-12T12:00:00Z",
            updatedAt: "2026-11-12T12:01:00Z",
            attempts: 5,
            finalError: "429 Too Many Requests",
          },
        ],
        tiersConfig: null,
        onAckAlert: noop,
        onRetryAlert: noop,
      }),
    );
    expect(html).toContain("Queue Swept: 1 sent");
    expect(html).toContain("1 Dead");
    expect(html).toContain("429 Too Many Requests");
    expect(html).toContain("Retry DLQ");
  });

  test("LiveWagersTabPanel renders incoming wagers table and selected ticket inspector", () => {
    const noop = () => {};
    const wager = SAMPLE_LIVE_WAGERS[0]!;
    const html = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        wagerSearch: "",
        onWagerSearchChange: noop,
        wagerSportFilter: "ALL",
        onWagerSportFilterChange: noop,
        wagerAlertFilter: "ALL",
        onWagerAlertFilterChange: noop,
        wagerTypeFilter: "ALL",
        onWagerTypeFilterChange: noop,
        wagerSortField: "timestamp",
        wagerSortDir: "desc",
        onWagerSort: noop,
        selectedWager: wager,
        onSelectWager: noop,
        copiedTicketId: null,
        onCopyText: noop,
        tiersConfig: null,
        onSelectCustomerById: noop,
        onInspectPty: noop,
      }),
    );
    expect(html).toContain("Live Incoming Wagers");
    expect(html).toContain("Ticket Inspector: #W-109281");
    expect(html).toContain("Kansas City Chiefs @ Buffalo Bills");
  });

  test("ShiftHandoffModal renders operator handoff summary and DLQ status note", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(ShiftHandoffModal, {
        shiftOperator: "nolarose",
        onShiftOperatorChange: noop,
        shiftLoading: false,
        onRefresh: noop,
        shiftSummary: {
          date: "2026-11-12",
          operatorId: "nolarose",
          totalAlerts: 12,
          deliveredAlerts: 10,
          failedAttempts: 1,
          deadLetterAlerts: 2,
          acknowledgedAlerts: 4,
          terminalCommandsCount: 9,
          loginEventsCount: 1,
        },
        onClose: noop,
      }),
    );
    expect(html).toContain("Operator Shift Handoff Summary");
    expect(html).toContain("2026-11-12");
    expect(html).toContain("2 dead alert(s) in DLQ");
  });

  test("BetTickerTabPanel and R2PipelineTabPanel SSR render channels, types, sinks, and remediation", () => {
    const noop = () => {};
    const tickerHtml = renderToStaticMarkup(
      React.createElement(BetTickerTabPanel, {
        data: {
          schemaVersion: 1,
          observedAt: "2026-11-12T18:00:00Z",
          autoExecute: false,
          provenance: {
            kind: "live",
            label: "live feed",
            sourcePath: "data/live-wagers.json",
            observedAt: "2026-11-12T18:00:00Z",
          },
          localFeed: {
            rawRowCount: 5,
            actionableTicketCount: 3,
            sentinelNoiseCount: 2,
            totalWageredCents: 150000,
            totalVolumeCents: 185000,
            totalToWinCents: 135000,
            volumeDiffersCount: 1,
            vipCount: 1,
            liveCount: 1,
            flagCount: 1,
            byRule: { HIGH_STAKE: 1 },
            byWriter: [
              {
                writer: "Internet",
                count: 2,
                wageredCents: 100000,
                volumeCents: 135000,
                toWinCents: 90000,
                isSentinelNoise: false,
              },
              {
                writer: "ALERT",
                count: 2,
                wageredCents: 0,
                volumeCents: 0,
                toWinCents: 0,
                isSentinelNoise: true,
              },
            ],
            byWagerType: [
              {
                wagerType: "S",
                label: "Spread",
                count: 2,
                wageredCents: 100000,
                volumeCents: 135000,
                toWinCents: 90000,
              },
            ],
            tickets: [
              {
                ticketId: "9001",
                customerId: "GP301",
                agentId: "FAKEMONEY",
                ticketWriter: "Internet",
                isSentinelNoise: false,
                wagerType: "S",
                wagerTypeLabel: "Spread",
                wageredCents: 50000,
                volumeCents: 75000,
                toWinCents: 45000,
                volumeDiffers: true,
                vip: true,
                live: false,
                insertedAt: "2026-11-12T18:00:00Z",
                legCount: 1,
                shortDesc: "[NFL] Chiefs -3",
                sport: "NFL",
                selection: "Chiefs -3",
                alertFlags: ["HIGH_STAKE"],
              },
            ],
          },
          bridge3aR2: {
            available: true,
            publicUrl:
              "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/f402-bet-ticker/latest.json",
            state: "fresh",
            lastModified: "2026-11-12T17:58:00Z",
            ageSeconds: 120,
            generatedAt: "2026-11-12T17:58:00Z",
            deskDate: "2026-11-12",
            deskHour: 12,
            watermark: "768283486",
            rowCount: 87,
            ticketCount: 87,
            legCount: 110,
            alertTwinCount: 25,
            orphanCount: 25,
            byChannel: {
              Internet: { tickets: 40, legs: 50, volumeCents: 120000 },
            },
            byWagerType: {
              S: { tickets: 60, legs: 60, wageredCents: 200000 },
            },
          },
          pendingGames: {
            available: true,
            gameCount: 12,
            pendingCount: 12,
            totalWageredCents: 350000,
            totalToWinCents: 310000,
            capturedAt: "2026-11-12T17:55:00Z",
            dataSource: "Report/Pending",
            sourcePath: "data/live-bets.json",
          },
          captureHealth: {
            available: true,
            status: "ok",
            capturedAt: "2026-11-12T17:59:00Z",
            ageSeconds: 60,
            rowCount: 5,
            sourcePath: "data/capture-health.json",
          },
        },
        loading: false,
        error: null,
        onRefresh: noop,
        onSelectAgent: noop,
        onSelectCustomerById: noop,
        onInspectPty: noop,
      }),
    );
    expect(tickerHtml).toContain("768283486");
    expect(tickerHtml).toContain("Internet");
    expect(tickerHtml).toContain("/agent/FAKEMONEY");
    expect(tickerHtml).not.toContain("https://desk.bookdeskops.com/agent/");

    const r2Html = renderToStaticMarkup(
      React.createElement(R2PipelineTabPanel, {
        data: {
          schemaVersion: 1,
          bucketPublicBase:
            "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev",
          observedAt: "2026-11-12T18:00:00Z",
          overallStatus: "stale",
          freshCount: 1,
          totalCount: 4,
          staleKeys: ["gslive-tally/latest.json"],
          dataStaleKeys: ["gslive-tally/latest.json"],
          sinks: [
            {
              id: "gslive-tally",
              key: "gslive-tally/latest.json",
              label: "gslive tally",
              description: "Bridge 3c rollup",
              publicUrl:
                "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/gslive-tally/latest.json",
              resolvedRollupKey: "gslive-tally/2026-11-09/rollup.json",
              resolvedRollupUrl:
                "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/gslive-tally/2026-11-09/rollup.json",
              slaSeconds: 3600,
              state: "stale",
              stale: true,
              lastModified: "2026-11-12T15:00:00Z",
              ageSeconds: 10800,
              dataAgeSeconds: 100000,
              dataStale: true,
              contentLength: 512,
              sha256: "abc123",
              reason: "Age exceeds 1h SLA",
              remediationCommand: "bun run tally:bridge3c",
              metrics: [{ label: "Desk Date", value: "2026-11-09" }],
            },
          ],
          daemon4020: {
            online: true,
            url: "http://127.0.0.1:4020/health",
            status: 200,
            latencyMs: 2,
            checkedAt: "2026-11-12T18:00:00Z",
          },
        },
        loading: false,
        error: null,
        onRefresh: noop,
      }),
    );
    expect(r2Html).toContain("gslive tally");
    expect(r2Html).toContain("bun run tally:bridge3c");
    expect(r2Html).toContain("2026-11-09");
  });

  test("UI panels, ANSI renderer, and dashboard.md replace dead desk.bookdeskops.com/agent/ URLs with local links", () => {
    const noop = () => {};
    const custHtml = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: false,
        onDismissBanner: noop,
        kpisCollapsed: false,
        onToggleKpis: noop,
        searchQuery: "",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: SAMPLE_PROFILE_DATA,
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: SAMPLE_PROFILE_DATA[0]!,
        onSelectCustomer: noop,
        copiedCliId: null,
        onCopyCli: noop,
        customerForensicResult: null,
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
      }),
    );
    const wagersHtml = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        wagerSearch: "",
        onWagerSearchChange: noop,
        wagerSportFilter: "ALL",
        onWagerSportFilterChange: noop,
        wagerAlertFilter: "ALL",
        onWagerAlertFilterChange: noop,
        wagerTypeFilter: "ALL",
        onWagerTypeFilterChange: noop,
        wagerSortField: "timestamp",
        wagerSortDir: "desc",
        onWagerSort: noop,
        selectedWager: SAMPLE_LIVE_WAGERS[0]!,
        onSelectWager: noop,
        copiedTicketId: null,
        onCopyText: noop,
        tiersConfig: null,
        onSelectCustomerById: noop,
        onInspectPty: noop,
      }),
    );
    const rankingsHtml = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: noop,
        rankingsFilter: "ALL",
        onRankingsFilterChange: noop,
        onInspectPty: noop,
      }),
    );
    const ansiHtml = renderToStaticMarkup(
      React.createElement(
        "div",
        null,
        renderAnsiReact(
          "\x1b]8;;https://desk.bookdeskops.com/agent/FAKEMONEY\x07FAKEMONEY\x1b]8;;\x07",
        ),
      ),
    );
    const dashboardMd = readFileSync(
      resolve(import.meta.dir, "..", "dashboard.md"),
      "utf8",
    );

    expect(custHtml).not.toContain("https://desk.bookdeskops.com/agent/");
    expect(wagersHtml).not.toContain("https://desk.bookdeskops.com/agent/");
    expect(rankingsHtml).not.toContain("https://desk.bookdeskops.com/agent/");
    expect(ansiHtml).toContain('href="/agent/FAKEMONEY"');
    expect(ansiHtml).not.toContain("https://desk.bookdeskops.com/agent/");
    expect(dashboardMd).not.toContain("https://desk.bookdeskops.com/agent/");
  });
});
