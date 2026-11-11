import { expect, open, test } from "nsh/test";

const STUB_KPIS = {
  success: true,
  generatedAt: "2026-11-10T19:45:00.000Z",
  kpis: {
    agents: {
      total: 2276,
      agents: 1679,
      masters: 596,
      provenance: {
        source: "scratch/agent-graph.json",
        basis: "fixture",
        asOf: "2026-11-09T04:11:20.581Z",
        ageSeconds: 120,
        stale: false,
        partial: false,
      },
    },
    pending: {
      wagers: 169,
      tickets: 169,
      wageredCents: 2069864,
      toWinCents: 12668020,
      provenance: {
        source: "live:/cloud/api/Report/Pending",
        basis: "capture",
        asOf: "2026-11-10T07:19:28.024Z",
        ageSeconds: 44900,
        stale: true,
        partial: false,
      },
    },
  },
  pipeline: {
    r2: {
      "f402-weblog": {
        state: "fresh",
        ageSeconds: 1800,
        stale: false,
        dataAgeSeconds: 503000,
        dataStale: true,
        reason: "30m old (SLA 1h30m)",
      },
    },
  },
};

const STUB_KALSHI = {
  success: true,
  generatedAt: "2026-11-10T19:45:00.000Z",
  provenance: {
    dataMode: "PARTIAL",
    asOf: "2026-11-04T20:00:38.143Z",
    ageSeconds: 517600,
    stale: true,
    fixture: true,
    sources: ["docs/graph-live-feed.json"],
  },
  kalshi: { ok: true, degraded: false },
  signals: [
    {
      id: "NBA-BOS_LAL-1q_total-55.5-over",
      league: "NBA",
      marketKind: "1q_total",
      teams: ["LAL", "BOS"],
      sideTeam: null,
      line: 55.5,
      overUnder: "over",
      distinctAccounts: 2,
      riskUsd: 27700,
      fairProb: 0.4651,
      confidence: 60,
      provenance: {
        dataMode: "PARTIAL",
        ageSeconds: 517600,
        stale: true,
        fixture: true,
        sources: ["docs/graph-live-feed.json"],
      },
      kalshi: {
        edgeBps: 420,
        verdict: "actionable",
        reason: "spread within 4c",
      },
      accounts: [
        {
          login: "MJ102",
          agentId: "MJ2026",
          archetype: "On-Chain CTF Whale",
          riskUsd: 16200,
        },
      ],
    },
    {
      id: "NFL-NE_MIA-spread-2.5",
      league: "NFL",
      marketKind: "spread",
      teams: ["NE", "MIA"],
      sideTeam: "MIA",
      line: -2.5,
      overUnder: null,
      distinctAccounts: 3,
      riskUsd: 63000,
      fairProb: 0.541,
      confidence: 78,
      provenance: {
        dataMode: "PARTIAL",
        ageSeconds: 517600,
        stale: true,
        fixture: true,
        sources: ["docs/graph-live-feed.json"],
      },
      kalshi: {
        edgeBps: 510,
        verdict: "actionable",
        reason: "sharp consensus",
      },
      accounts: [
        {
          login: "VIP88",
          agentId: "AG100",
          archetype: "Sharp Syndicate",
          riskUsd: 42000,
        },
      ],
    },
  ],
};

const STUB_SCOREBOARD = {
  schemaVersion: 1,
  source: "operator paste of fantasy402 manager.html scoreboard",
  observedAt: "2026-11-01",
  summary: { games: 1, live: 0, final: 1, scheduled: 0 },
  games: [
    {
      league: "NFL",
      status: "final",
      period: "Final",
      team1: { name: "Vikings", score: 15 },
      team2: { name: "Lions", score: 19 },
    },
  ],
};

function defaultStubNetwork(onKpiCall?: () => void) {
  return {
    "GET http://127.0.0.1:4020/api/kpis": () => {
      onKpiCall?.();
      return { status: 200, body: STUB_KPIS };
    },
    "GET http://127.0.0.1:4020/api/signals/kalshi": {
      status: 200,
      body: STUB_KALSHI,
    },
    "GET http://127.0.0.1:4020/api/scoreboard": {
      status: 200,
      body: STUB_SCOREBOARD,
    },
    "GET http://127.0.0.1:4020/api/live-bets/summary": {
      status: 503,
      body: {
        success: false,
        error: "live Report/Pending unavailable",
        live: {
          diagnostic: {
            code: "unauthorized",
            message: "Report/Pending returned 401",
          },
        },
      },
    },
  };
}

test("renders workspace, ranked exposure plot, provenance badges, 503 diagnostic honesty, and keyboard refresh", async () => {
  let kpiCalls = 0;
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    network: defaultStubNetwork(() => {
      kpiCalls += 1;
    }),
  });

  await app.waitUntil(() => app.texts().some((t) => t.includes("2,276 nodes")));

  const texts = app.texts().join("\n");
  expect(texts).toContain("Sportsdesk Desk");
  expect(texts).toContain("http://127.0.0.1:4020 [default:4020]");
  expect(texts).toContain("fixture · 2m");
  expect(texts).toContain("[DATA-STALE]");
  expect(texts).toContain(
    "/api/live-bets/summary HTTP 503 [unauthorized]: live Report/Pending unavailable — Report/Pending returned 401",
  );
  // Highest-risk signal ($63.0K NFL NE@MIA) is selected first and ranked #1 in Exposure Plot
  expect(texts).toContain("VIP88 (AG100)");
  expect(texts).toContain("RANK #1");
  expect(texts).toContain("Exposure $63.0K");

  await app.press("Refresh");
  await app.waitUntil(() => kpiCalls >= 2);
  expect(kpiCalls).toBeGreaterThanOrEqual(2);

  await app.keyboard.press("mod+r");
  await app.waitUntil(() => kpiCalls >= 3);
  expect(kpiCalls).toBeGreaterThanOrEqual(3);
});

test("surfaces explicit unavailable cause instead of zero when signals endpoint fails", async () => {
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    network: {
      "GET http://127.0.0.1:4020/api/kpis": { status: 200, body: STUB_KPIS },
      "GET http://127.0.0.1:4020/api/signals/kalshi": {
        status: 503,
        body: {
          error: "kalshi upstream unavailable",
          code: "upstream_down",
        },
      },
      "GET http://127.0.0.1:4020/api/scoreboard": {
        status: 200,
        body: STUB_SCOREBOARD,
      },
      "GET http://127.0.0.1:4020/api/live-bets/summary": {
        status: 200,
        body: { totalWagers: 12, totalRiskUsd: 4500, mode: "live" },
      },
    },
  });

  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Kalshi signals unavailable")),
  );
  const texts = app.texts().join("\n");
  expect(texts).toContain(
    "/api/signals/kalshi HTTP 503 [upstream_down]: kalshi upstream unavailable",
  );
});

test("syncs appearance across Command palette, Workspace menu, UI kit, and Storage", async () => {
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    colorScheme: "light",
    reducedMotion: true,
    network: defaultStubNetwork(),
  });

  await app.waitUntil(() => app.texts().some((t) => t.includes("2,276 nodes")));

  const lightTitleStyle = app.spanStyle("text:Sportsdesk Desk");
  expect(lightTitleStyle.color.toLowerCase()).toBe("#0f172aff");
  expect(lightTitleStyle.fontSize).toBeGreaterThanOrEqual(12);

  // Open Command palette via mod+k, filter to Dark appearance, and execute
  await app.keyboard.press("mod+k");
  await app.waitFor("text:Sportsdesk Desk command palette");
  await app.type(
    "label:Search workspace commands and signals",
    "Appearance: Dark",
  );
  await app.press("text:Appearance: Dark");
  await app.waitFor("text:Sportsdesk Desk command palette", { state: "gone" });

  await app.waitUntil(
    () => app.storage()["ops.sportsdesk.desk.appearance.v1"] === "dark",
  );
  const darkTitleStyle = app.spanStyle("text:Sportsdesk Desk");
  expect(darkTitleStyle.color.toLowerCase()).toBe("#f1f5f9ff");

  // Use Command palette to jump to the #2 NBA BOS_LAL signal
  await app.keyboard.press("mod+k");
  await app.waitFor("text:Sportsdesk Desk command palette");
  await app.type("label:Search workspace commands and signals", "LAL@BOS");
  await app.press(
    "text:NBA · LAL@BOS · 1q_total (over 55.5) ($27.7K · actionable)",
  );
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("MJ102 (MJ2026)")),
  );

  // Verify UI kit reflects synced appearance and closes cleanly on Escape
  await app.keyboard.press("mod+u");
  await app.waitFor("text:Sportsdesk UI kit");
  expect(app.texts().join("\n")).toContain("Buttons — variants & states");

  await app.keyboard.press("escape");
  await app.waitFor("text:Sportsdesk UI kit", { state: "gone" });
});

test("adapts cleanly to compact mobile viewport with drawer/sheet docks", async () => {
  const app = await open("./App.tsx", {
    platform: "ios",
    width: 390,
    height: 844,
    reducedMotion: true,
    network: defaultStubNetwork(),
  });

  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("NFL-NE_MIA-spread-2.5")),
  );
  expect(app.shows("Refresh")).toBe(true);
  expect(app.shows("id:open-command-palette")).toBe(true);
  expect(app.shows("id:workspace-menu")).toBe(true);
});

test("hydrates Storage preferences, persists lock mutations, and copies diagnostics JSON to Clipboard", async () => {
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    reducedMotion: true,
    storage: {
      "ops.sportsdesk.desk.prefs.v1": JSON.stringify({
        schemaVersion: 1,
        leagueFilter: "NBA",
        autoPoll: true,
        locked: false,
        dockOpen: { left: true, bottom: true },
      }),
      "ops.sportsdesk.desk.appearance.v1": "dark",
    },
    network: defaultStubNetwork(),
  });

  await app.waitUntil(() => app.texts().some((t) => t.includes("2,276 nodes")));
  expect(app.spanStyle("text:Sportsdesk Desk").color.toLowerCase()).toBe(
    "#f1f5f9ff",
  );

  await app.keyboard.press("mod+shift+l");
  await app.waitUntil(() => {
    const raw = app.storage()["ops.sportsdesk.desk.prefs.v1"];
    if (typeof raw !== "string") return false;
    const parsed = JSON.parse(raw) as {
      locked?: boolean;
      leagueFilter?: string;
      autoPoll?: boolean;
    };
    return (
      parsed.locked === true &&
      parsed.leagueFilter === "NBA" &&
      parsed.autoPoll === true
    );
  });

  await app.keyboard.press("mod+shift+c");
  await app.waitUntil(() => app.clipboard() !== null);

  const clipText = app.clipboard() ?? "";
  const diag = JSON.parse(clipText) as {
    appId: string;
    origin: string;
    originSource: string;
    endpoints: Array<{ endpoint: string; status: string; cause?: string }>;
    r2Sinks: Array<{ sink: string; windowDivergent: boolean }>;
  };
  expect(diag.appId).toBe("ops.sportsdesk.desk");
  expect(diag.origin).toBe("http://127.0.0.1:4020");
  expect(diag.originSource).toBe("default:4020");
  expect(
    diag.endpoints.find((e) => e.endpoint === "/api/live-bets/summary")?.cause,
  ).toContain("HTTP 503 [unauthorized]");
  expect(diag.r2Sinks[0]?.windowDivergent).toBe(true);
  expect(app.shows("id:diagnostics-copied-badge")).toBe(true);
});

test("renders live-bets summary telemetry when HTTP 200 and recovers from root ErrorBoundary", async () => {
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    reducedMotion: true,
    host: {
      params: {
        __testForceRenderError: "Simulated panel crash",
      },
    },
    network: {
      ...defaultStubNetwork(),
      "GET http://127.0.0.1:4020/api/live-bets/summary": {
        status: 200,
        body: { totalWagers: 14, totalRiskUsd: 6250, mode: "live" },
      },
    },
  });

  await app.waitFor("text:Workspace render error");
  expect(app.texts().join("\n")).toContain("Simulated panel crash");

  await app.press("Reload workspace");
  await app.waitUntil(() => app.texts().some((t) => t.includes("2,276 nodes")));
  const texts = app.texts().join("\n");
  expect(texts).toContain("Sportsdesk Desk");
  expect(texts).toContain("HTTP 200 · 14 wagers · $6250 [live]");
});
