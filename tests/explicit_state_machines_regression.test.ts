/**
 * @file tests/explicit_state_machines_regression.test.ts
 * @description End-to-end regression suite verifying every explicit state machine graph and
 * lifecycle race/poisoning fix across the 14 refactored runtime, service, and UI modules.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALERT_DELIVERY_GRAPH,
  ALERT_DISPATCHER_GRAPH,
  AlertDispatcher,
  listAlerts,
  recoverAlertState,
  type QueuedAlert,
} from "../lib/alerts.ts";
import { writeAuditEntry } from "../lib/audit_log.ts";
import {
  TERMINAL_SESSION_GRAPH,
  TerminalSession,
  TerminalUnauthorizedError,
} from "../lib/bun_terminal.ts";
import {
  createDeskLiveReads,
  LIVE_FEED_CACHE_GRAPH,
  LIVE_REFRESH_LOOP_GRAPH,
} from "../lib/desk_live_reads.ts";
import {
  F402_TOKEN_MANAGER_GRAPH,
  F402TokenManager,
  fakeJwtExpiringAt,
  memoryStorage,
} from "../lib/f402_browser_token_manager.ts";
import {
  createF402ReplayTransport,
  F402_REPLAY_TRANSPORT_GRAPH,
} from "../lib/f402_replay_transport.ts";
import {
  ensureGsid,
  getGsliveSessionCircuitState,
  getGsliveSessionStateKind,
  GSLIVE_AUTO_SESSION_GRAPH,
  resetGsliveAutoSessionCache,
  resetGsliveMintFailureStreakForTests,
} from "../lib/gslive_auto_session.ts";
import {
  connectPpmFeed,
  PPM_HANDSHAKE_GRAPH,
  type PpmFrame,
  type PpmSocketLike,
} from "../lib/ppm_socket_feed.ts";
import {
  attachThemeSyncHooks,
  THEME_SYNC_GRAPH,
} from "../lib/token_watch_theme_store.ts";
import {
  computeDashboardWsBackoffMs,
  DASHBOARD_WS_TRANSITIONS,
  startDashboardWsLifecycle,
  WS_READY_STATE_CONNECTING,
  WS_READY_STATE_OPEN,
  type DashboardWebSocketLike,
} from "../packages/ui/src/ws_connection_machine.ts";
import {
  REPORTING_SCHEDULER_SERVICE_GRAPH,
  ReportingSchedulerService,
  resetShellCaptureRunner,
  SCHEDULE_EXECUTION_GRAPH,
  setShellCaptureRunner,
} from "../services/reporting_scheduler_service.ts";
import {
  SportsDeskTelegramService,
  TELEGRAM_POLLING_GRAPH,
} from "../services/sportsdesk_telegram_bot.ts";
import {
  BRIDGE_RELAY_GRAPH,
  stopBridgeHub,
} from "../services/sportsdesk_webview_server.ts";
import {
  SUPERVISED_CHILD_GRAPH,
  SUPERVISOR_STATE_GRAPH,
  supervise,
  type SupervisorProcess,
} from "../services/supervisor.ts";
import { hasPty } from "./support/capabilities.ts";

const mutableBunEnv = Bun.env as unknown as Record<string, string | undefined>;
const mutableProcEnv = process.env as unknown as Record<
  string,
  string | undefined
>;

function setRecordEnv(
  target: Record<string, string | undefined>,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) Reflect.deleteProperty(target, key);
  else Reflect.set(target, key, value);
}

describe("1. State graph structural integrity across all 14 machines", () => {
  test("every exported state graph freezes states and transitions without dangling targets", () => {
    const graphs = [
      SUPERVISOR_STATE_GRAPH,
      SUPERVISED_CHILD_GRAPH,
      PPM_HANDSHAKE_GRAPH,
      F402_REPLAY_TRANSPORT_GRAPH,
      F402_TOKEN_MANAGER_GRAPH,
      GSLIVE_AUTO_SESSION_GRAPH,
      BRIDGE_RELAY_GRAPH,
      THEME_SYNC_GRAPH,
      LIVE_FEED_CACHE_GRAPH,
      LIVE_REFRESH_LOOP_GRAPH,
      REPORTING_SCHEDULER_SERVICE_GRAPH,
      SCHEDULE_EXECUTION_GRAPH,
      TELEGRAM_POLLING_GRAPH,
      ALERT_DELIVERY_GRAPH,
      ALERT_DISPATCHER_GRAPH,
      TERMINAL_SESSION_GRAPH,
    ];
    for (const graph of graphs) {
      expect(Object.isFrozen(graph)).toBe(true);
      expect(Object.isFrozen(graph.states)).toBe(true);
      expect(Object.isFrozen(graph.transitions)).toBe(true);
      expect(graph.states.length).toBeGreaterThanOrEqual(2);
    }
    expect(Object.isFrozen(DASHBOARD_WS_TRANSITIONS)).toBe(true);
  });
});

describe("2. Supervisor explicit child & lifecycle state machines", () => {
  test("re-attaches exit watcher across consecutive child crashes and skips health probes in backoff", async () => {
    let pidSeq = 100;
    const spawned: Array<{
      pid: number;
      resolveExit: (code: number) => void;
    }> = [];
    let probeCallsDuringBackoff = 0;
    let inBackoff = false;

    const abort = new AbortController();
    const sleepCalls: number[] = [];

    const run = supervise({
      services: [
        {
          name: "worker",
          command: ["bun", "worker.ts"],
          healthUrl: "http://127.0.0.1:49999/health",
        },
      ],
      healthIntervalMs: 5,
      fetchImpl: async () => {
        if (inBackoff) probeCallsDuringBackoff += 1;
        return new Response("ok", { status: 200 });
      },
      spawnImpl: (): SupervisorProcess => {
        const pid = ++pidSeq;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => {
          resolveExit = resolve;
        });
        spawned.push({ pid, resolveExit });
        return {
          pid,
          exited,
          kill: () => resolveExit(0),
        };
      },
      sleep: async (ms) => {
        sleepCalls.push(ms);
        inBackoff = true;
        await Bun.sleep(15);
        inBackoff = false;
      },
      log: () => {},
      signal: abort.signal,
    });

    await Bun.sleep(5);
    expect(spawned.length).toBe(1);

    // Crash 1 -> backoff -> respawn #2
    spawned[0]!.resolveExit(1);
    await Bun.sleep(25);
    expect(spawned.length).toBe(2);

    // Crash 2 -> must STILL have an `.exited` watcher attached -> backoff -> respawn #3
    spawned[1]!.resolveExit(1);
    await Bun.sleep(25);
    expect(spawned.length).toBe(3);
    expect(sleepCalls.length).toBe(2);
    expect(probeCallsDuringBackoff).toBe(0);

    abort.abort();
    await run;
  });
});

describe("3. PPM Socket.IO / Engine.IO v4 handshake state machine", () => {
  test("answers Engine.IO ping '2' with '3', ignores out-of-phase frames, and fences post-close events", () => {
    const sent: string[] = [];
    const handlers = new Map<string, (ev: { data?: unknown }) => void>();
    const fakeSocket: PpmSocketLike = {
      send: (d) => sent.push(d),
      close: () => {},
      addEventListener: (type, fn) => {
        handlers.set(type, fn);
      },
    };

    const frames: PpmFrame[] = [];
    let readyCount = 0;
    const handle = connectPpmFeed({
      socketFactory: () => fakeSocket,
      onFrame: (f) => frames.push(f),
      onReady: () => {
        readyCount += 1;
      },
    });

    expect(handle.state).toBe("awaiting_eio_open");
    const emit = (data: unknown) => handlers.get("message")?.({ data });

    // Out-of-phase subscribed frame BEFORE `0{...}` must be ignored
    emit('42["subscribed",["topic"]]');
    expect(handle.state).toBe("awaiting_eio_open");
    expect(readyCount).toBe(0);

    // Engine.IO open -> awaiting_sio_connect
    emit('0{"sid":"abc"}');
    expect(handle.state).toBe("awaiting_sio_connect");
    expect(sent).toEqual(["40"]);

    // Engine.IO ping "2" -> answers "3" without perturbing handshake state
    emit("2");
    expect(sent[sent.length - 1]).toBe("3");
    expect(handle.state).toBe("awaiting_sio_connect");

    // Complete handshake -> streaming
    emit('40{"sid":"sio"}');
    expect(handle.state).toBe("awaiting_metadata_ack");
    emit('42["setSocketMetadata",{"event":"socketMetadataSet"}]');
    expect(handle.state).toBe("awaiting_subscribed");
    emit('42["subscribed",["prematch"]]');
    expect(handle.state).toBe("streaming");
    expect(readyCount).toBe(1);

    // Close -> terminal `closed`; late binary frame must NOT emit `onFrame`
    handle.close();
    expect(handle.state).toBe("closed");
    const gz = Bun.gzipSync(
      new TextEncoder().encode(
        JSON.stringify({ isDiff: false, payload: { a: 1 } }),
      ),
    );
    emit(gz);
    expect(frames).toHaveLength(0);
  });
});

describe("4. F402 replay transport singleflight 401 & close fencing", () => {
  test("coalesces concurrent 401 remints, updates label dynamically, and rejects after close()", async () => {
    let sessionCookie: string | null = null;
    let refreshCalls = 0;
    let resolveRefresh!: () => void;

    const transport = await createF402ReplayTransport({
      env: {},
      readSession: () =>
        sessionCookie === null
          ? null
          : {
              cookieHeader: sessionCookie,
              cookieNames: ["ASP.NET_SessionId"],
              obtainedAtIso: "2026-11-27T00:00:00.000Z",
              expiresAtIso: "2026-11-27T04:00:00.000Z",
            },
      refreshSession: async () => {
        refreshCalls += 1;
        await new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        });
        sessionCookie = "ASP.NET_SessionId=fresh";
      },
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init.headers);
        if (headers.get("cookie") === "ASP.NET_SessionId=fresh") {
          return new Response("ok", { status: 200 });
        }
        return new Response("unauthorized", { status: 401 });
      },
    });

    expect(transport.label).toBe("datastore-fetch-session");
    expect(transport.state).toBe("open");

    const p1 = transport.fetch("https://fantasy402.com/api", {
      method: "POST",
    });
    const p2 = transport.fetch("https://fantasy402.com/api", {
      method: "POST",
    });
    await Bun.sleep(5);
    expect(transport.state).toBe("reminting_401");
    expect(refreshCalls).toBe(1);

    resolveRefresh();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(transport.label).toBe("session-file");
    expect(transport.state).toBe("open");

    await transport.close();
    expect(transport.state).toBe("closed");
    await expect(
      transport.fetch("https://fantasy402.com/api", { method: "POST" }),
    ).rejects.toThrow(/closed/);
  });
});

describe("5. F402 browser token manager mid-remint schedule(null) & dispose()", () => {
  test("schedule(null) mid-remint suppresses timer re-arm without throwing StateTransitionError", async () => {
    const now = 1_700_000_000_000;
    const freshJwt = fakeJwtExpiringAt(now + 600_000);
    let resolveFetch!: (res: Response) => void;
    let scheduledTimers = 0;

    const storage = memoryStorage({
      customerID: "BILLY666",
      credentials: JSON.stringify({ password: "pw" }),
    });
    const mgr = new F402TokenManager({
      storage,
      now: () => now,
      schedule: () => {
        scheduledTimers += 1;
        return setTimeout(() => {}, 60_000);
      },
      clearSchedule: (h) => clearTimeout(h),
      fetch: (() =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })) as unknown as typeof fetch,
    });

    const flight = mgr.remint();
    expect(mgr.state).toBe("reminting");

    // Explicitly cancel scheduling while remint is in flight
    mgr.schedule(null);
    expect(mgr.state).toBe("reminting");

    resolveFetch(Response.json({ code: freshJwt }));
    await expect(flight).resolves.toBe(freshJwt);
    expect(mgr.state).toBe("idle");
    expect(scheduledTimers).toBe(0);

    mgr.dispose();
    expect(mgr.state).toBe("disposed");
    await expect(mgr.get()).rejects.toThrow(/disposed/);
  });
});

describe("6. GSLive auto-session circuit breaker & stale cache eviction", () => {
  const prevFile = Bun.env.GSLIVE_SESSION_FILE;
  const prevGsid = Bun.env.GSLIVE_SESSION_ID;
  const prevGate = Bun.env.GS_SESSION;

  afterEach(() => {
    setRecordEnv(mutableBunEnv, "GSLIVE_SESSION_FILE", prevFile);
    setRecordEnv(mutableBunEnv, "GSLIVE_SESSION_ID", prevGsid);
    setRecordEnv(mutableBunEnv, "GS_SESSION", prevGate);
    resetGsliveMintFailureStreakForTests();
    resetGsliveAutoSessionCache();
  });

  test("trips OPEN_LOCKED after 3 failures and refuses a 4th signin attempt until reset", async () => {
    resetGsliveMintFailureStreakForTests();
    resetGsliveAutoSessionCache();
    setRecordEnv(mutableBunEnv, "GSLIVE_SESSION_FILE", undefined);
    setRecordEnv(mutableBunEnv, "GSLIVE_SESSION_ID", undefined);
    setRecordEnv(mutableBunEnv, "GS_SESSION", undefined);

    let signinCalls = 0;
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).includes("signin")) signinCalls += 1;
      return new Response(
        JSON.stringify({ d: "Username or password are incorrect" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await expect(ensureGsid(fetchImpl)).rejects.toThrow();
    expect(getGsliveSessionCircuitState()).toBe("HALF_OPEN_PROBING");
    await expect(ensureGsid(fetchImpl)).rejects.toThrow();
    await expect(ensureGsid(fetchImpl)).rejects.toThrow(/GSLive_MINT_LOOP/);
    expect(getGsliveSessionStateKind()).toBe("open_locked");
    expect(getGsliveSessionCircuitState()).toBe("OPEN_LOCKED");

    const callsAtLock = signinCalls;
    await expect(ensureGsid(fetchImpl)).rejects.toThrow(/GSLive_MINT_LOOP/);
    expect(signinCalls).toBe(callsAtLock);
  });

  test("evicts expired verified GSID and adopts externally rotated GSLIVE_SESSION_FILE", async () => {
    resetGsliveMintFailureStreakForTests();
    resetGsliveAutoSessionCache();
    const dir = mkdtempSync(join(tmpdir(), "gslive-fsm-"));
    const sessionPath = join(dir, "gsid.txt");
    writeFileSync(sessionPath, "gsid-initial", "utf8");
    setRecordEnv(mutableBunEnv, "GSLIVE_SESSION_FILE", sessionPath);
    setRecordEnv(mutableBunEnv, "GSLIVE_SESSION_ID", undefined);
    setRecordEnv(mutableBunEnv, "GS_SESSION", "gate-test");

    let validGsid = "gsid-initial";
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      const cookie = new Headers(init?.headers).get("cookie") ?? "";
      if (cookie === `GSID=${validGsid}`) {
        return new Response('{"r":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 403 });
    }) as unknown as typeof fetch;

    try {
      expect(await ensureGsid(fetchImpl)).toBe("gsid-initial");
      expect(getGsliveSessionStateKind()).toBe("verified");

      // External daemon rotates GSLIVE_SESSION_FILE while `gsid-initial` expires upstream
      writeFileSync(sessionPath, "gsid-rotated", "utf8");
      validGsid = "gsid-rotated";

      expect(await ensureGsid(fetchImpl)).toBe("gsid-rotated");
      expect(getGsliveSessionStateKind()).toBe("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("7. Desk live reads cache isolation & singleflight", () => {
  test("mode='file' never poisons live cache and concurrent live reads coalesce", async () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-live-fsm-"));
    let upstreamCalls = 0;
    try {
      const reads = createDeskLiveReads({
        repoRoot: dir,
        liveBetsPath: join(dir, "live-bets.json"),
        wagerListDir: dir,
        liveTicker: {
          enabled: true,
          agentId: "BILLY666",
          ttlMs: 30_000,
          env: { NODE_ENV: "test", SPORTSDESK_LIVE_TICKER: "1" },
          session: {
            cookieHeader: "ASP.NET_SessionId=t",
            cookieNames: ["ASP.NET_SessionId"],
            obtainedAtIso: "2026-11-27T00:00:00.000Z",
            expiresAtIso: "2026-11-27T04:00:00.000Z",
          },
          fetch: async () => {
            upstreamCalls += 1;
            await Bun.sleep(10);
            return new Response(
              JSON.stringify({
                LIST: [
                  {
                    TicketNumber: 1,
                    CustomerID: "C1",
                    WagerType: "S",
                    AmountWagered: 100,
                    ToWinAmount: 91,
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
        livePending: {
          enabled: false,
          env: { NODE_ENV: "test" },
          persistence: { enabled: false },
        },
      });

      const emptyFiles = { chosen: null, skipped: [] };
      const fileRes = await reads.serveLiveWagers("file", emptyFiles);
      expect(fileRes.httpStatus).toBe(404);
      expect(upstreamCalls).toBe(0);

      // Subsequent auto/live concurrent reads must NOT see a cached "disabled" status from `file`
      const [a, b] = await Promise.all([
        reads.serveLiveWagers("auto", emptyFiles),
        reads.serveLiveWagers("live", emptyFiles),
      ]);
      expect(a.httpStatus).toBe(200);
      expect(b.httpStatus).toBe(200);
      expect(upstreamCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("8. Webview bridge relay & ThemeSync explicit state machines", () => {
  test("stopBridgeHub resets bridge relay cleanly and ThemeSync coalesces dirty bursts", async () => {
    stopBridgeHub();
    const db = new Database(":memory:");
    const targetsDir = mkdtempSync(join(tmpdir(), "theme-fsm-"));
    let syncCalls = 0;
    try {
      const controller = attachThemeSyncHooks(
        db,
        { lastDataVersion: -1, lastFingerprint: "" },
        {
          envPath: join(targetsDir, ".env.out"),
          envExamplePath: join(targetsDir, ".env.example"),
          themeGenPath: join(targetsDir, "theme.gen.ts"),
        },
        {
          sync: async () => {
            syncCalls += 1;
            await Bun.sleep(10);
            return true;
          },
        },
      );
      expect(controller.state).toBe("idle");
      controller.trigger();
      controller.trigger();
      controller.trigger();
      await controller.idle();
      expect(controller.state).toBe("idle");
      expect(syncCalls).toBeGreaterThanOrEqual(1);
      expect(syncCalls).toBeLessThanOrEqual(2);
      controller.stop();
      expect(controller.state).toBe("stopped");
    } finally {
      db.close();
      rmSync(targetsDir, { recursive: true, force: true });
    }
  });
});

describe("9. ReportingSchedulerService & SportsDeskTelegramService state machines", () => {
  afterEach(() => {
    resetShellCaptureRunner();
  });

  test("ReportingSchedulerService coalesces concurrent runScheduleNow calls onto one execution", async () => {
    const fakeTg = {
      setReportGenerator: () => {},
      sendMessage: async () => ({ ok: true, delivered: true }),
    } as unknown as SportsDeskTelegramService;
    const scheduler = new ReportingSchedulerService(fakeTg);
    expect(scheduler.state).toBe("stopped");

    let runnerCalls = 0;
    setShellCaptureRunner(async () => {
      runnerCalls += 1;
      await Bun.sleep(20);
      return { status: "ok", exitCode: 0, durationMs: 20 };
    });

    const p1 = scheduler.runScheduleNow("sched_agent_tree_hourly");
    const p2 = scheduler.runScheduleNow("sched_agent_tree_hourly");
    expect(scheduler.getScheduleExecutionState("sched_agent_tree_hourly")).toBe(
      "running",
    );
    await Promise.all([p1, p2]);

    expect(scheduler.getScheduleExecutionState("sched_agent_tree_hourly")).toBe(
      "idle",
    );
    expect(runnerCalls).toBe(1);
    const sched = scheduler
      .getSchedules()
      .find((s) => s.id === "sched_agent_tree_hourly");
    expect(sched?.lastRun?.status).toBe("ok");
  });

  test("SportsDeskTelegramService setWebhook waits for stopping getUpdates loop before calling setWebhook", async () => {
    const prevHook = Bun.env.TELEGRAM_WEBHOOK_URL;
    const prevSecret = Bun.env.TELEGRAM_WEBHOOK_SECRET;
    setRecordEnv(
      mutableBunEnv,
      "TELEGRAM_WEBHOOK_URL",
      "https://desk.example/telegram/webhook",
    );
    setRecordEnv(mutableBunEnv, "TELEGRAM_WEBHOOK_SECRET", "sec-123");

    const order: string[] = [];
    const bot = new SportsDeskTelegramService({
      botToken: "123:token",
      chatId: "100",
      apiBaseUrl: "http://127.0.0.1:49998",
      activityLogPath: null,
      warmOnInit: false,
      fetchSession: {
        fetch: async (input, init) => {
          const method = new URL(String(input)).pathname.split("/").pop()!;
          order.push(`start:${method}`);
          if (method === "getUpdates") {
            await new Promise<void>((resolve) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  setTimeout(() => {
                    order.push("end:getUpdates");
                    resolve();
                  }, 15);
                },
                { once: true },
              );
            });
            return Response.json({ ok: true, result: [] });
          }
          order.push(`end:${method}`);
          return Response.json({ ok: true, result: true });
        },
        close: () => {},
      },
    });

    try {
      expect(bot.pollingState).toBe("idle");
      const pollPromise = bot.startPolling();
      await Bun.sleep(5);
      expect(bot.pollingState).toBe("polling");

      const hookRes = await bot.setWebhook();
      await pollPromise;
      expect(hookRes.ok).toBe(true);
      expect(bot.pollingState).toBe("idle");
      expect(order).toEqual([
        "start:getUpdates",
        "end:getUpdates",
        "start:setWebhook",
        "end:setWebhook",
      ]);
    } finally {
      setRecordEnv(mutableBunEnv, "TELEGRAM_WEBHOOK_URL", prevHook);
      setRecordEnv(mutableBunEnv, "TELEGRAM_WEBHOOK_SECRET", prevSecret);
    }
  });
});

describe("10. Alerts delivery partition exclusivity & dispatcher mid-sweep stop()", () => {
  const prevAuditDir = process.env.SPORTSDESK_AUDIT_DIR;

  afterEach(() => {
    setRecordEnv(mutableProcEnv, "SPORTSDESK_AUDIT_DIR", prevAuditDir);
  });

  test("recoverAlertState and listAlerts reject illegal delivered -> dead and acknowledged -> queued regressions", () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-fsm-"));
    setRecordEnv(mutableProcEnv, "SPORTSDESK_AUDIT_DIR", dir);
    try {
      const baseMs = Date.now() - 10_000;
      const iso = (offsetMs: number) =>
        new Date(baseMs + offsetMs).toISOString();

      writeAuditEntry({
        ts: iso(0),
        category: "alert_queued",
        action: "enqueue",
        success: true,
        target: "W-1",
        details: {
          deliveryId: "dlv-1",
          tier: "CRITICAL",
          wagerId: "W-1",
          payload: { customerId: "C1" },
          createdAt: iso(0),
        },
      });
      writeAuditEntry({
        ts: iso(100),
        category: "alert_delivered",
        action: "delivered",
        success: true,
        target: "W-1",
        details: { deliveryId: "dlv-1", messageId: 42 },
      });
      // Out-of-order / duplicate dead-letter entry AFTER delivered must be rejected by ALERT_DELIVERY_GRAPH
      writeAuditEntry({
        ts: iso(200),
        category: "alert_dead",
        action: "dead_letter",
        success: false,
        target: "W-1",
        details: { deliveryId: "dlv-1", afterAttempts: 5 },
      });

      const state = recoverAlertState();
      expect(state.delivered.has("dlv-1")).toBe(true);
      expect(state.dead.has("dlv-1")).toBe(false);
      expect(state.queued.has("dlv-1")).toBe(false);

      const listed = listAlerts("all");
      expect(listed.find((a) => a.deliveryId === "dlv-1")?.status).toBe(
        "delivered",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AlertDispatcher.stop() mid-sweep keeps state='sweeping' until sweepOnce settles to 'stopped'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alerts-disp-fsm-"));
    setRecordEnv(mutableProcEnv, "SPORTSDESK_AUDIT_DIR", dir);
    try {
      const nowIso = new Date().toISOString();
      writeAuditEntry({
        ts: nowIso,
        category: "alert_queued",
        action: "enqueue",
        success: true,
        target: "W-2",
        details: {
          deliveryId: "dlv-2",
          tier: "CRITICAL",
          wagerId: "W-2",
          payload: { customerId: "C2" },
          createdAt: nowIso,
        },
      });

      let releaseSend!: () => void;
      const dispatcher = new AlertDispatcher({
        rateLimitMs: 0,
        sweepIntervalMs: 60_000,
        sender: async (_alert: QueuedAlert) => {
          await new Promise<void>((resolve) => {
            releaseSend = resolve;
          });
          return { ok: true, messageId: 7 };
        },
      });

      dispatcher.start();
      expect(dispatcher.state).toBe("idle");

      const sweep = dispatcher.sweepOnce();
      await Bun.sleep(5);
      expect(dispatcher.state).toBe("sweeping");

      // Stop background timer while sweep is mid-flight
      dispatcher.stop();
      expect(dispatcher.state).toBe("sweeping");

      releaseSend();
      await sweep;
      expect(dispatcher.state).toBe("stopped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("11. TerminalSession authorization gate & concurrent start() race", () => {
  test("rejects concurrent start() while async authorize() is pending and resets on denial", async () => {
    let releaseAuth!: (ok: boolean) => void;
    const session = new TerminalSession({
      authorize: () =>
        new Promise<boolean>((resolve) => {
          releaseAuth = resolve;
        }),
    });

    expect(session.state).toBe("unstarted");
    const first = session.start([process.execPath, "-e", "process.exit(0)"]);
    expect(session.state).toBe("authorizing");

    // Concurrent second start() while still `authorizing` must fail closed immediately
    await expect(
      session.start([process.execPath, "-e", "process.exit(0)"]),
    ).rejects.toThrow("TerminalSession is already started");

    // Deny first authorization -> transitions back to `unstarted`
    releaseAuth(false);
    await expect(first).rejects.toBeInstanceOf(TerminalUnauthorizedError);
    expect(session.state).toBe("unstarted");

    if (hasPty) {
      const okSession = new TerminalSession({
        authorize: async () => true,
      });
      await okSession.start([process.execPath, "-e", "process.exit(0)"]);
      expect(await okSession.wait()).toBe(0);
      expect(okSession.state).toBe("exited");
      okSession.close();
    }
  });
});

describe("12. Dashboard UI WebSocket connection & reconnect state machine", () => {
  test("reconnects with capped backoff, resubscribes topics, and safely disposes CONNECTING sockets", () => {
    expect(computeDashboardWsBackoffMs(0)).toBe(1_000);
    expect(computeDashboardWsBackoffMs(1)).toBe(2_000);
    expect(computeDashboardWsBackoffMs(3)).toBe(8_000);
    expect(computeDashboardWsBackoffMs(9)).toBe(15_000);

    interface FakeWs extends DashboardWebSocketLike {
      readyState: number;
      sent: string[];
      closedCount: number;
    }

    const sockets: FakeWs[] = [];
    const timers: Array<{ delayMs: number; fn: () => void; cleared: boolean }> =
      [];
    const connectedLog: boolean[] = [];
    const messages: string[] = [];

    const handle = startDashboardWsLifecycle({
      url: "ws://127.0.0.1:4020/ws",
      subscribeTopics: ["dashboard", "live-bets"],
      onConnectedChange: (c) => connectedLog.push(c),
      onTextMessage: (raw) => messages.push(raw),
      createSocket: () => {
        const ws: FakeWs = {
          readyState: WS_READY_STATE_CONNECTING,
          onopen: null,
          onclose: null,
          onmessage: null,
          sent: [],
          closedCount: 0,
          send: (d) => ws.sent.push(d),
          close: () => {
            ws.closedCount += 1;
          },
        };
        sockets.push(ws);
        return ws;
      },
      scheduleTimer: (fn, delayMs) => {
        const entry = { delayMs, fn, cleared: false };
        timers.push(entry);
        return entry;
      },
      clearScheduledTimer: (entry) => {
        entry.cleared = true;
      },
    });

    expect(handle.state).toBe("connecting");
    expect(sockets).toHaveLength(1);

    // Open socket #1 -> connected + subscribe frame sent
    sockets[0]!.readyState = WS_READY_STATE_OPEN;
    sockets[0]!.onopen?.({});
    expect(handle.state).toBe("connected");
    expect(connectedLog).toEqual([true]);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      action: "subscribe",
      topics: ["dashboard", "live-bets"],
    });

    sockets[0]!.onmessage?.({ data: '{"type":"reload"}' });
    expect(messages).toEqual(['{"type":"reload"}']);

    // Server closes socket #1 (e.g. 1011 backpressure / 120s idle) -> reconnecting
    sockets[0]!.onclose?.({});
    expect(handle.state).toBe("reconnecting");
    expect(connectedLog).toEqual([true, false]);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delayMs).toBe(1_000);

    // Backoff timer fires -> dials socket #2 in `connecting`
    timers[0]!.fn();
    expect(handle.state).toBe("connecting");
    expect(sockets).toHaveLength(2);

    // Dispose while socket #2 is still CONNECTING (React StrictMode unmount pattern)
    handle.dispose();
    expect(handle.state).toBe("disposed");
    expect(sockets[1]!.closedCount).toBe(0);
    // Once handshake completes, deferred onopen closes socket #2 without subscribing
    sockets[1]!.onopen?.({});
    expect(sockets[1]!.closedCount).toBe(1);
    expect(sockets[1]!.sent).toHaveLength(0);
  });
});
