import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseDashboardWsSignal } from "@sportsdesk-ops/contracts";
import "./desk.css";
import { ShadowPricingPanel } from "./ShadowPricingPanel.tsx";
import { styles } from "./dashboard_styles.ts";
import {
  normalizeCustomersCohortResponse,
  normalizeLiveWagersResponse,
  SHOWCASE_WAGERS_PROVENANCE,
} from "./hydration.ts";
import { DASHBOARD_API, dashboardApiUrl } from "./config/dashboard.ts";
import { resolveInitialTab, tabHref } from "./tab_routes.ts";
import { bookRowsToProfiles } from "./profile_rows.ts";
import {
  AgentInspectorModal,
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
  ThresholdsPanel,
} from "./panels/index.tsx";
import {
  debugDashboardTrace,
  getDashboardRuntimeFlags,
} from "./runtime_flags.ts";
import {
  CLIENT_AUTOCOMPLETE_COMMANDS,
  KNOWN_ID_LIST,
  PROXY_CONDUITS_30D,
  RANKED_30D_PLAYERS,
  SAMPLE_LIVE_WAGERS,
  SAMPLE_PROFILE_DATA,
  TERMINAL_INITIAL_COMMANDS,
  TERMINAL_WELCOME_HELP_STDOUT,
} from "./showcase_data.ts";
import type {
  AlertFilter,
  AlertToastState,
  BetTickerApiResponse,
  BuildMatrixRow,
  CustomersApiResponse,
  CustomerSortKey,
  DashboardAlertRecord,
  DashboardData,
  DashboardSourceProvenance,
  DashboardTabId,
  DnsData,
  HealthData,
  LiveWager,
  R2PipelineApiResponse,
  RankingsFilter,
  ShiftSummaryData,
  ShowcaseCustomer,
  TerminalCategory,
  TerminalHistoryEntry,
  TierStyleConfig,
  WagerSortField,
} from "./types.ts";

export * from "./types.ts";
export {
  KNOWN_ID_LIST,
  PROXY_CONDUITS_30D,
  RANKED_30D_PLAYERS,
  SAMPLE_LIVE_WAGERS,
  SAMPLE_PROFILE_DATA,
};

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)sd_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1] ?? "") : "";
}

function apiPostHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const csrf = getCsrfToken();
  if (csrf) {
    headers["x-csrf-token"] = csrf;
  }
  return headers;
}

function resolveInitialUrlParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name)?.trim() ?? "";
}

export function App(): React.ReactElement {
  const runtimeFlags = getDashboardRuntimeFlags();
  const [activeTab, setActiveTab] = useState<DashboardTabId>(() =>
    typeof window === "undefined"
      ? "customers"
      : resolveInitialTab(window.location.search, window.location.pathname),
  );
  const [showBuildMatrix, setShowBuildMatrix] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("matrix") === "1"
      : false,
  );

  // Keep the URL honest so every tab is linkable and reloads back to itself.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (activeTab === "customers") url.searchParams.delete("tab");
    else url.searchParams.set("tab", activeTab);
    window.history.replaceState(null, "", url);
  }, [activeTab]);

  const [buildMatrixRows, setBuildMatrixRows] = useState<
    readonly BuildMatrixRow[] | null
  >(null);
  const [buildMatrixLoading, setBuildMatrixLoading] = useState<boolean>(false);
  const [rankingsFilter, setRankingsFilter] = useState<RankingsFilter>("ALL");
  const [rankingsSearch, setRankingsSearch] = useState<string>(() =>
    resolveInitialUrlParam("agent"),
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => {
    const a = resolveInitialUrlParam("agent");
    return a ? a.toUpperCase() : null;
  });
  const [wagerSearch, setWagerSearch] = useState("");
  const [wagerSportFilter, setWagerSportFilter] = useState<string>("ALL");
  const [wagerAlertFilter, setWagerAlertFilter] = useState<string>("ALL");
  const [wagerTypeFilter, setWagerTypeFilter] = useState<string>("ALL");
  const [copiedTicketId, setCopiedTicketId] = useState<string | null>(null);
  const [selectedWager, setSelectedWager] = useState<LiveWager | null>(
    SAMPLE_LIVE_WAGERS[0] ?? null,
  );
  const [wagerSortField, setWagerSortField] =
    useState<WagerSortField>("timestamp");
  const [wagerSortDir, setWagerSortDir] = useState<"asc" | "desc">("desc");
  const [clockTime, setClockTime] = useState<string>("");
  const [terminalCategory, setTerminalCategory] =
    useState<TerminalCategory>("ALL");
  const [copiedTerminalIdx, setCopiedTerminalIdx] = useState<number | null>(
    null,
  );
  const [data, setData] = useState<DashboardData | null>(null);
  const [dnsData, setDnsData] = useState<DnsData | null>(null);
  const [viewMode, setViewMode] = useState<"interactive" | "raw">(
    "interactive",
  );
  const [connected, setConnected] = useState(false);
  const [benchResult, setBenchResult] = useState<string | null>(null);
  const [benchLoading, setBenchLoading] = useState(false);
  const [reverseIp, setReverseIp] = useState("1.1.1.1");
  const [reverseResult, setReverseResult] = useState<string | null>(null);

  // Customer Showcase state
  const [searchQuery, setSearchQuery] = useState(() =>
    resolveInitialUrlParam("search"),
  );
  const [filterTier, setFilterTier] = useState<string>("ALL");
  const [copiedCliId, setCopiedCliId] = useState<string | null>(null);
  const [profileRows, setProfileRows] =
    useState<readonly ShowcaseCustomer[]>(SAMPLE_PROFILE_DATA);
  const [selectedCustomer, setSelectedCustomer] =
    useState<ShowcaseCustomer | null>(() => {
      const q = resolveInitialUrlParam("search").toUpperCase();
      if (q) {
        const match = profileRows.find((c) => c.id.toUpperCase() === q);
        if (match) return match;
      }
      return profileRows[0] ?? null;
    });
  const [customerForensicResult, setCustomerForensicResult] = useState<
    string | null
  >(null);
  // Keep the detail panel on a row that exists after the book replaces the sample rows.
  useEffect(() => {
    if (profileRows.length === 0) return;
    if (profileRows.some((row) => row.id === selectedCustomer?.id)) return;
    setSelectedCustomer(profileRows[0] ?? null);
  }, [profileRows, selectedCustomer?.id]);

  // Runtime Declarative Wager Tiers + Live API Hydration state
  const [tiersConfig, setTiersConfig] = useState<TierStyleConfig | null>(null);
  const [liveWagers, setLiveWagers] =
    useState<readonly LiveWager[]>(SAMPLE_LIVE_WAGERS);
  const [wagersProvenance, setWagersProvenance] =
    useState<DashboardSourceProvenance>(SHOWCASE_WAGERS_PROVENANCE);
  const [wagersError, setWagersError] = useState<string | null>(null);
  const [betTickerData, setBetTickerData] =
    useState<BetTickerApiResponse | null>(null);
  const [betTickerLoading, setBetTickerLoading] = useState<boolean>(false);
  const [betTickerError, setBetTickerError] = useState<string | null>(null);
  const [r2PipelineData, setR2PipelineData] =
    useState<R2PipelineApiResponse | null>(null);
  const [r2PipelineLoading, setR2PipelineLoading] = useState<boolean>(false);
  const [r2PipelineError, setR2PipelineError] = useState<string | null>(null);
  const [cohortsReport, setCohortsReport] =
    useState<CustomersApiResponse | null>(null);
  const [cohortsStatus, setCohortsStatus] = useState<
    "pending" | "ready" | "unavailable"
  >("pending");
  const [cohortsError, setCohortsError] = useState<string | null>(null);

  const fetchTiersConfig = async () => {
    try {
      const res = await fetch(dashboardApiUrl(DASHBOARD_API.tiers));
      if (!res.ok) return;
      const cfg = (await res.json()) as { tiers?: TierStyleConfig } | null;
      if (cfg?.tiers) {
        setTiersConfig(cfg.tiers);
      }
    } catch (err) {
      console.warn(
        "[dashboard] failed to load /api/config/tiers, keeping defaults:",
        err,
      );
    }
  };

  const fetchLiveWagers = async () => {
    try {
      const res = await fetch(dashboardApiUrl(DASHBOARD_API.wagers));
      if (!res.ok) {
        setWagersError(
          `GET /api/wagers returned HTTP ${res.status} (${res.statusText || "error"})`,
        );
        return;
      }
      const normalized = normalizeLiveWagersResponse(await res.json());
      if (!normalized) {
        setWagersError(
          "GET /api/wagers returned unexpected LiveWagersApiResponse payload",
        );
        return;
      }
      setLiveWagers(normalized.wagers);
      setWagersProvenance(normalized.provenance);
      setWagersError(null);
      if (normalized.wagers.length > 0) {
        setSelectedWager((prev) =>
          prev && normalized.wagers.some((w) => w.ticketId === prev.ticketId)
            ? prev
            : (normalized.wagers[0] ?? null),
        );
      }
    } catch (err) {
      setWagersError(
        `GET /api/wagers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const fetchCustomersCohorts = async () => {
    try {
      const res = await fetch(dashboardApiUrl(DASHBOARD_API.customers));
      if (!res.ok) {
        setCohortsStatus("unavailable");
        setCohortsError(
          `GET /api/customers returned HTTP ${res.status} (${res.statusText || "error"})`,
        );
        return;
      }
      const normalized = normalizeCustomersCohortResponse(await res.json());
      if (!normalized) {
        setCohortsStatus("unavailable");
        setCohortsError(
          "GET /api/customers returned unexpected CustomersApiResponse payload",
        );
        return;
      }
      setCohortsReport(normalized);
      const mappedRows = bookRowsToProfiles(normalized.fixtures ?? []);
      if (mappedRows.length > 0) setProfileRows(mappedRows);
      setCohortsStatus("ready");
      setCohortsError(null);
    } catch (err) {
      setCohortsStatus("unavailable");
      setCohortsError(
        `GET /api/customers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const fetchBetTicker = async () => {
    setBetTickerLoading(true);
    try {
      const res = await fetch("/api/bet-ticker");
      if (!res.ok) {
        setBetTickerError(
          `GET /api/bet-ticker returned HTTP ${res.status} (${res.statusText || "error"})`,
        );
        return;
      }
      const payload = (await res.json()) as BetTickerApiResponse;
      setBetTickerData(payload);
      setBetTickerError(null);
    } catch (err) {
      setBetTickerError(
        `GET /api/bet-ticker failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBetTickerLoading(false);
    }
  };

  const fetchR2Pipeline = async (force = false) => {
    setR2PipelineLoading(true);
    try {
      const res = await fetch(
        force ? "/api/r2/pipeline?refresh=1" : "/api/r2/pipeline",
      );
      if (!res.ok) {
        setR2PipelineError(
          `GET /api/r2/pipeline returned HTTP ${res.status} (${res.statusText || "error"})`,
        );
        return;
      }
      const payload = (await res.json()) as R2PipelineApiResponse;
      setR2PipelineData(payload);
      setR2PipelineError(null);
    } catch (err) {
      setR2PipelineError(
        `GET /api/r2/pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setR2PipelineLoading(false);
    }
  };

  useEffect(() => {
    void fetchTiersConfig();
    void fetchLiveWagers();
    void fetchCustomersCohorts();
    void fetchBetTicker();
    void fetchR2Pipeline();
  }, []);

  // UI enhancement states: banner dismissal & collapsible KPI cards
  const [bannerDismissed, setBannerDismissed] = useState(
    () =>
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem("portalBannerDismissed") === "1",
  );
  const [kpisCollapsed, setKpisCollapsed] = useState(() => {
    try {
      return localStorage.getItem("kpisCollapsed") === "1";
    } catch {
      return false;
    }
  });

  // Alerts, DLQ, and Operator Shift state
  const [alertRecords, setAlertRecords] = useState<DashboardAlertRecord[]>([]);
  const [alertFilter, setAlertFilter] = useState<AlertFilter>("ALL");
  const [alertLoading, setAlertLoading] = useState(false);
  const [alertToast, setAlertToast] = useState<AlertToastState | null>(null);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false);
  const [shiftSummary, setShiftSummary] = useState<ShiftSummaryData | null>(
    null,
  );
  const [shiftOperator, setShiftOperator] = useState<string>("operator");
  const [shiftLoading, setShiftLoading] = useState(false);

  const fetchHealth = () => {
    fetch("/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((health) => {
        if (health) {
          setHealthData(health);
        }
      })
      .catch(() => {});
  };

  const fetchAlerts = (filter = alertFilter) => {
    setAlertLoading(true);
    const param = filter.toLowerCase();
    fetch(`/api/alerts?status=${param}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((res) => {
        if (res?.alerts) {
          setAlertRecords(res.alerts);
        }
      })
      .catch((err) => {
        console.warn("[alerts] fetch failed:", err);
      })
      .finally(() => setAlertLoading(false));
  };

  const fetchShiftSummary = async (operatorId = shiftOperator) => {
    setShiftLoading(true);
    try {
      const res = await fetch(
        `/api/shift/summary?operatorId=${encodeURIComponent(operatorId)}`,
      );
      if (res.ok) {
        const summary = await res.json();
        setShiftSummary(summary);
      }
    } catch (e) {
      console.warn("[shift] summary fetch failed:", e);
    } finally {
      setShiftLoading(false);
    }
  };

  const handleAckAlert = async (deliveryId: string, notes?: string) => {
    try {
      const res = await fetch(`/api/alerts/${deliveryId}/ack`, {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({ operatorId: shiftOperator, notes }),
      });
      if (res.ok) {
        setAlertToast({
          message: `Alert ${deliveryId.slice(0, 8)} acknowledged`,
          type: "success",
        });
        fetchAlerts(alertFilter);
        fetchHealth();
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setAlertToast({
          message: `Ack failed: ${err.error ?? res.statusText}`,
          type: "error",
        });
      }
    } catch (e) {
      setAlertToast({ message: `Ack failed: ${String(e)}`, type: "error" });
    }
  };

  const handleRetryAlert = async (deliveryId: string) => {
    try {
      const res = await fetch(`/api/alerts/${deliveryId}/retry`, {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({ operatorId: shiftOperator }),
      });
      if (res.ok) {
        const payload = await res.json();
        setAlertToast({
          message: `DLQ Replayed! New UUID: ${payload.newDeliveryId?.slice(0, 8)}`,
          type: "success",
        });
        fetchAlerts(alertFilter);
        fetchHealth();
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setAlertToast({
          message: `Retry failed: ${err.error ?? res.statusText}`,
          type: "error",
        });
      }
    } catch (e) {
      setAlertToast({ message: `Retry failed: ${String(e)}`, type: "error" });
    }
  };

  const handleSweepAlerts = async () => {
    try {
      const res = await fetch(`/api/alerts/sweep`, {
        method: "POST",
        headers: apiPostHeaders(),
      });
      if (res.ok) {
        const payload = await res.json();
        setAlertToast({
          message: `Queue Swept: ${payload.sweep?.sent ?? 0} sent, ${payload.sweep?.failed ?? 0} failed, ${payload.sweep?.dead ?? 0} dead`,
          type: "info",
        });
        fetchAlerts(alertFilter);
        fetchHealth();
      }
    } catch (e) {
      setAlertToast({ message: `Sweep failed: ${String(e)}`, type: "error" });
    }
  };

  // Poll /health every 15s (0 disk I/O, in-memory probe)
  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  // When switching to alerts tab, fetch alerts
  useEffect(() => {
    if (activeTab === "alerts") {
      fetchAlerts(alertFilter);
    }
  }, [activeTab, alertFilter]);

  // Auto-dismiss toast after 4s
  useEffect(() => {
    if (!alertToast) return;
    const t = setTimeout(() => setAlertToast(null), 4000);
    return () => clearTimeout(t);
  }, [alertToast]);

  // Terminal Emulator state
  const [terminalHistory, setTerminalHistory] = useState<
    TerminalHistoryEntry[]
  >([
    {
      command: "help",
      stdout: TERMINAL_WELCOME_HELP_STDOUT,
      exitCode: 0,
      durationMs: 0,
      timestamp: Date.now(),
    },
  ]);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>(
    TERMINAL_INITIAL_COMMANDS,
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const terminalBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey && e.key === "`") ||
        ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")
      ) {
        e.preventDefault();
        setActiveTab("terminal");
        setTimeout(() => {
          const inputEl = document.querySelector<HTMLInputElement>(
            "input[data-terminal-input]",
          );
          inputEl?.focus();
        }, 50);
      } else if (e.ctrlKey && e.key === "1") {
        e.preventDefault();
        setActiveTab("customers");
      } else if (e.ctrlKey && e.key === "2") {
        e.preventDefault();
        setActiveTab("surveillance");
      } else if (e.ctrlKey && e.key === "3") {
        e.preventDefault();
        setActiveTab("terminal");
        setTimeout(() => {
          const inputEl = document.querySelector<HTMLInputElement>(
            "input[data-terminal-input]",
          );
          inputEl?.focus();
        }, 50);
      } else if (e.ctrlKey && e.key === "4") {
        e.preventDefault();
        setActiveTab("rankings");
      } else if (e.ctrlKey && e.key === "5") {
        e.preventDefault();
        setActiveTab("wagers");
      } else if (e.ctrlKey && e.key === "6") {
        e.preventDefault();
        setActiveTab("alerts");
      } else if (e.ctrlKey && e.key === "7") {
        e.preventDefault();
        setActiveTab("shadow");
      } else if (e.ctrlKey && e.key === "8") {
        e.preventDefault();
        setActiveTab("bet-ticker");
      } else if (e.ctrlKey && e.key === "9") {
        e.preventDefault();
        setActiveTab("r2");
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const et = now.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const ct = now.toLocaleTimeString("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      setClockTime(`${et} ET · ${ct} CT`);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleWagerSort = (field: WagerSortField) => {
    if (wagerSortField === field) {
      setWagerSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setWagerSortField(field);
      setWagerSortDir("desc");
    }
  };

  const handleAutocomplete = () => {
    const trimmed = terminalCommand.trimStart();
    if (!trimmed) {
      setTerminalCommand("help");
      return;
    }

    const tokens = trimmed.split(/\s+/);
    if (tokens.length === 1) {
      const prefix = tokens[0]!.toLowerCase();
      const cmdMatch = CLIENT_AUTOCOMPLETE_COMMANDS.find((c) =>
        c.toLowerCase().startsWith(prefix),
      );
      if (cmdMatch) {
        setTerminalCommand(cmdMatch + " ");
        return;
      }
      const idMatch = KNOWN_ID_LIST.find((id) =>
        id.toLowerCase().startsWith(prefix),
      );
      if (idMatch) {
        setTerminalCommand("p " + idMatch);
        return;
      }
    } else if (tokens.length === 2) {
      const cmd = tokens[0]!.toLowerCase();
      const argPrefix = tokens[1]!.toUpperCase();
      if (cmd === "profile" || cmd === "p" || cmd === "c") {
        const idMatch = KNOWN_ID_LIST.find((id) =>
          id.toUpperCase().startsWith(argPrefix),
        );
        if (idMatch) {
          setTerminalCommand(`${tokens[0]} ${idMatch}`);
          return;
        }
      } else if (cmd === "find" || cmd === "f") {
        const candidates = [
          "-t",
          "-s",
          "-a",
          "sharp",
          "syndicate",
          "CFB",
          "NFL",
        ];
        const match = candidates.find((c) =>
          c.toLowerCase().startsWith(tokens[1]!.toLowerCase()),
        );
        if (match) {
          setTerminalCommand(`${tokens[0]} ${match} `);
          return;
        }
      }
    }
  };

  const runTerminalCommand = async (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (trimmed.toLowerCase() === "clear") {
      setTerminalHistory([]);
      setTerminalCommand("");
      return;
    }

    setCommandHistory((prev) => [
      ...prev.filter((c) => c !== trimmed),
      trimmed,
    ]);
    setHistoryIndex(-1);
    setTerminalLoading(true);

    try {
      const res = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed, cols: 100, rows: 30 }),
      });

      if (res.ok) {
        const json = await res.json();
        setTerminalHistory((prev) => [...prev, json]);
      } else {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setTerminalHistory((prev) => [
          ...prev,
          {
            command: trimmed,
            stdout: `\x1b[31m[TERMINAL_ERROR] ${err.error || "Failed execution"}\x1b[0m`,
            exitCode: 1,
            durationMs: 0,
            timestamp: Date.now(),
          },
        ]);
      }
    } catch {
      // Local client fallback
      const upper = trimmed.toUpperCase();
      const cust = profileRows.find((c) => c.id === upper);
      let stdout = "";
      if (cust) {
        stdout =
          `\x1b[1;36m🎯 SPORTSDESK BEHAVIORAL PROFILE: ${cust.id}\x1b[0m\n` +
          `  Name: ${cust.name} | Agent: ${cust.agentId} | Tier: \x1b[1;33m${cust.tier}\x1b[0m (Score: \x1b[1m${cust.score}/10\x1b[0m)\n` +
          `  Strategy: ${cust.sizingStrategy} | Stake Gini: \x1b[1m${cust.gini}\x1b[0m | Mean Stake: $${cust.meanStake}\n` +
          `  Timing: ${cust.timingArchetype} | Correlated Risk: \x1b[31m${cust.correlatedRisk}\x1b[0m\n` +
          `  7d VaR (95%): $${cust.var95Usd.toLocaleString()} | Hold: ${cust.holdPct}%\n` +
          `  Recommended Limit: \x1b[1m$${cust.recommendedLimitUsd.toLocaleString()}\x1b[0m | Action: \x1b[1;31m${cust.action}\x1b[0m`;
      } else {
        stdout = `\x1b[33m[OFFLINE_FALLBACK] Executed: ${trimmed}\x1b[0m\n\x1b[90m(Start dev server via 'bun run dev' for live Bun.Terminal PTY)\x1b[0m`;
      }
      setTerminalHistory((prev) => [
        ...prev,
        {
          command: trimmed,
          stdout,
          exitCode: 0,
          durationMs: 5,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setTerminalLoading(false);
      setTerminalCommand("");
      setTimeout(() => {
        terminalBottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 50);
    }
  };

  const runBenchmark = async () => {
    setBenchLoading(true);
    try {
      const res = await fetch("/api/dns/benchmark?host=fantasy402.com");
      if (res.ok) {
        const json = await res.json();
        const metricsStr = (
          json.metrics as Array<{ backend: string; meanMs: number }>
        )
          .map((m) => `${m.backend}: ${m.meanMs}ms`)
          .join(" vs ");
        setBenchResult(
          `⚡ Fastest: ${json.fastestBackend} (${json.speedupFactor}x speedup) | ${metricsStr}`,
        );
      }
    } catch {
      setBenchResult("Benchmark failed");
    } finally {
      setBenchLoading(false);
    }
  };

  const runReverseLookup = async (ipToLookup?: string) => {
    const ip = ipToLookup || reverseIp;
    try {
      const res = await fetch(`/api/dns/reverse?ip=${encodeURIComponent(ip)}`);
      if (res.ok) {
        const json = await res.json();
        const resultMsg = `🔍 ${json.organization} | Cloud/DC: ${json.isDatacenterOrCloud ? "🚨 YES" : "NO"} | Proxy/VPN: ${json.isVpnOrProxySuspicious ? "⚠️ YES" : "NO"} | Host: ${json.primaryHostname || "none"}`;
        if (ipToLookup) {
          setCustomerForensicResult(resultMsg);
        } else {
          setReverseResult(resultMsg);
        }
      }
    } catch {
      if (ipToLookup) {
        setCustomerForensicResult("Lookup failed");
      } else {
        setReverseResult("Lookup failed");
      }
    }
  };

  const fetchDashboard = async () => {
    try {
      const [dashRes, dnsRes] = await Promise.all([
        fetch(dashboardApiUrl(DASHBOARD_API.dashboard)),
        fetch("/api/dns/telemetry").then(async (res) => {
          if (!res.ok) return fetch("/api/dns");
          return res;
        }),
      ]);
      if (dashRes.ok) {
        const json = (await dashRes.json()) as DashboardData;
        setData(json);
      }
      if (dnsRes.ok) {
        const json = (await dnsRes.json()) as DnsData;
        setDnsData(json);
      }
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
    }
  };

  useEffect(() => {
    void fetchDashboard();

    // Hot-reload WebSocket connection with React StrictMode-safe lifecycle
    let isMounted = true;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      if (isMounted) {
        setConnected(true);
        try {
          ws.send(
            JSON.stringify({
              action: "subscribe",
              topics: [
                "dashboard",
                "live-bets",
                "syndicate-alerts",
                "tiers-updated",
              ],
            }),
          );
        } catch {
          // signal-honesty: intentional-ignore-ws-subscribe-on-closing
        }
      } else {
        ws.close();
      }
    };
    ws.onclose = () => {
      if (isMounted) setConnected(false);
    };
    ws.onmessage = (event) => {
      if (!isMounted || typeof event.data !== "string") return;
      const action = parseDashboardWsSignal(event.data);
      switch (action.kind) {
        case "reload":
          void fetchDashboard();
          void fetchLiveWagers();
          void fetchBetTicker();
          void fetchCustomersCohorts();
          void fetchTiersConfig();
          break;
        case "dashboard-updated":
          void fetchDashboard();
          break;
        case "wagers-updated":
          void fetchLiveWagers();
          void fetchBetTicker();
          break;
        case "tiers-updated":
          if (action.tiers) {
            setTiersConfig(action.tiers as unknown as TierStyleConfig);
          } else {
            void fetchTiersConfig();
          }
          break;
        case "alerts-updated":
          fetchAlerts();
          fetchHealth();
          break;
        case "ack":
        case "ignore":
          break;
      }
    };

    return () => {
      isMounted = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        // Wait for handshake to finish before closing to avoid browser
        // "WebSocket is closed before the connection is established" warning in React StrictMode
        ws.onopen = () => ws.close();
      }
    };
  }, []);

  const filteredCustomers = profileRows.filter((cust) => {
    const matchesSearch =
      cust.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cust.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cust.specialization.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cust.agentId.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;
    if (filterTier === "ALL") return true;
    if (filterTier === "ELITE")
      return (
        cust.tier === "TIER_1_ELITE_ORIGINATOR" ||
        cust.tier === "TIER_2_STEAM_SYNDICATE"
      );
    if (filterTier === "SYNDICATE") return cust.syndicateRisk === "HIGH";
    if (filterTier === "STEAM") return cust.timingArchetype === "STEAM_CHASER";
    if (filterTier === "RECREATIONAL")
      return cust.tier === "TIER_5_RECREATIONAL";
    return true;
  });

  const unknownSyndicateCount = useMemo(
    () =>
      profileRows.filter(
        (cust) =>
          cust.unknown?.includes("syndicate") && cust.syndicateRisk !== "HIGH",
      ).length,
    [profileRows],
  );

  const [customerSort, setCustomerSort] = useState<{
    key: CustomerSortKey;
    dir: 1 | -1;
  }>({ key: "score", dir: -1 });

  const onCustomerSort = (key: CustomerSortKey) =>
    setCustomerSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 },
    );

  const sortedCustomers = useMemo(() => {
    return [...filteredCustomers].sort((a, b) => {
      const v =
        customerSort.key === "id"
          ? a.id.localeCompare(b.id)
          : (a[customerSort.key] as number) - (b[customerSort.key] as number);
      return v * customerSort.dir;
    });
  }, [filteredCustomers, customerSort]);

  const handleSelectCustomerById = (customerId: string) => {
    const upper = customerId.trim().toUpperCase();
    const found = profileRows.find((c) => c.id.toUpperCase() === upper);
    if (found) {
      setSelectedCustomer(found);
    }
    setSearchQuery(customerId);
    setActiveTab("customers");
  };

  return (
    <div style={styles.container}>
      {/* Global Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
            <h1 style={styles.title}>⚡ SportsDesk & Fantasy402 Operations</h1>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                fontSize: "11px",
                color: "#94a3b8",
              }}
            >
              <span style={{ color: "#38bdf8", fontWeight: 600 }}>
                ● Local :4022 SPA
              </span>
              <span>·</span>
              <span
                style={{
                  color: r2PipelineData?.daemon4020.online
                    ? "#4ade80"
                    : r2PipelineData
                      ? "#fbbf24"
                      : "#94a3b8",
                  fontWeight: 600,
                }}
                title={
                  r2PipelineData?.daemon4020.online
                    ? `SportsDesk Daemon :4020 online (${r2PipelineData.daemon4020.latencyMs ?? 1}ms)`
                    : `SportsDesk Daemon :4020 offline (${r2PipelineData?.daemon4020.reason ?? "probing..."})`
                }
              >
                {r2PipelineData?.daemon4020.online
                  ? `● API :4020 (${r2PipelineData.daemon4020.latencyMs ?? 1}ms)`
                  : r2PipelineData
                    ? "○ API :4020 Offline"
                    : "◌ API :4020 Probing..."}
              </span>
              <span>·</span>
              <button
                type="button"
                onClick={() => setActiveTab("r2")}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  fontSize: "11px",
                  fontWeight: 600,
                  color:
                    r2PipelineData?.overallStatus === "fresh"
                      ? "#4ade80"
                      : r2PipelineData?.overallStatus === "stale"
                        ? "#fbbf24"
                        : r2PipelineData
                          ? "#f87171"
                          : "#94a3b8",
                }}
                title="Open R2 Pipeline Monitor"
              >
                {r2PipelineData
                  ? `☁️ R2 ${r2PipelineData.freshCount}/${r2PipelineData.totalCount} Fresh`
                  : "☁️ R2 Probing..."}
              </button>
              <span>·</span>
              <a
                href={tabHref("wagers")}
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "#38bdf8",
                  textDecoration: "none",
                  fontWeight: 600,
                }}
              >
                📈 Live Bets ↗
              </a>
              <a
                href="/graph"
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "#38bdf8",
                  textDecoration: "none",
                  fontWeight: 600,
                }}
              >
                🕸️ Graph ↗
              </a>
              <a
                href="/status"
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "#38bdf8",
                  textDecoration: "none",
                  fontWeight: 600,
                }}
              >
                🩺 Status ↗
              </a>
              <span>·</span>
              <span style={{ color: "#f59e0b", fontWeight: 600 }}>
                🛡️ autoExecute: false
              </span>
              {clockTime && (
                <>
                  <span>·</span>
                  <span
                    style={{
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      color: "#f1f5f9",
                    }}
                  >
                    🕒 {clockTime}
                  </span>
                </>
              )}
            </div>
          </div>
          <span style={styles.badge(connected)}>
            {connected ? "● Live Hot-Reload Connected" : "○ Disconnected"}
          </span>
          {/* Live Alert Health Pill */}
          <button
            type="button"
            onClick={() => {
              void fetchShiftSummary();
              setIsShiftModalOpen(true);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 10px",
              borderRadius: "6px",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
              border: `1px solid ${
                healthData?.alerts?.status === "degraded"
                  ? "#ef4444"
                  : healthData?.alerts?.status === "warning"
                    ? "#f59e0b"
                    : "#22c55e"
              }`,
              background:
                healthData?.alerts?.status === "degraded"
                  ? "rgba(239, 68, 68, 0.15)"
                  : healthData?.alerts?.status === "warning"
                    ? "rgba(245, 158, 11, 0.15)"
                    : "rgba(34, 197, 94, 0.15)",
              color:
                healthData?.alerts?.status === "degraded"
                  ? "#f87171"
                  : healthData?.alerts?.status === "warning"
                    ? "#fbbf24"
                    : "#4ade80",
            }}
            title="Surveillance Alert Health (O(1) in-memory probe) · Click to view Shift Handoff Summary"
          >
            <span>
              {healthData?.alerts?.status === "degraded"
                ? "🚨 DEGRADED"
                : healthData?.alerts?.status === "warning"
                  ? "⚠️ WARNING"
                  : "● System OK"}
            </span>
            {healthData?.alerts && (
              <span style={{ color: "#94a3b8", fontSize: "10px" }}>
                (DLQ: {healthData.alerts.dead} · Backlog:{" "}
                {healthData.alerts.backlog})
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              void fetchShiftSummary();
              setIsShiftModalOpen(true);
            }}
            style={{
              padding: "4px 9px",
              borderRadius: "6px",
              fontSize: "11px",
              fontWeight: 600,
              background: "#1e293b",
              color: "#94a3b8",
              border: "1px solid #334155",
              cursor: "pointer",
            }}
            title="Operator Shift Summary Handoff"
          >
            📋 Shift Handoff
          </button>
          <button
            type="button"
            className="sd-pill sd-mono"
            style={{ cursor: "pointer" }}
            onClick={() => {
              const next = !showBuildMatrix;
              setShowBuildMatrix(next);
              if (next && !buildMatrixRows && !buildMatrixLoading) {
                setBuildMatrixLoading(true);
                fetch("/api/build-matrix")
                  .then((r) =>
                    r.ok
                      ? (r.json() as Promise<{
                          targets?: readonly BuildMatrixRow[];
                        }>)
                      : null,
                  )
                  .then((json) => {
                    if (json?.targets) {
                      debugDashboardTrace("loaded DCE build matrix", json);
                      setBuildMatrixRows(json.targets);
                    }
                  })
                  .catch((err) => {
                    console.warn("Build matrix probe unavailable:", err);
                  })
                  .finally(() => setBuildMatrixLoading(false));
              }
            }}
            title="Inspect compile-time bun:bundle dead-code elimination & tokens.toml CSS Houdini registry"
          >
            🧬 Target: {runtimeFlags.target.toUpperCase()} (
            {runtimeFlags.enabledFeatures.length > 0
              ? runtimeFlags.enabledFeatures.join("+")
              : "HMR"}
            )
          </button>
        </div>
        <div style={styles.tabNav}>
          <button
            type="button"
            style={styles.tabBtn(activeTab === "customers")}
            onClick={() => setActiveTab("customers")}
            title="Inspect individual sharp originators, sizing models, and risk (Ctrl+1)"
          >
            👥 Profiles ({profileRows.length})
            <span style={styles.keyShortcutBadge}>Ctrl+1</span>
          </button>
          <button
            type="button"
            style={styles.tabBtn(activeTab === "shadow")}
            onClick={() => setActiveTab("shadow")}
            title="Counterfactual Shadow Pricing & Slice Hold-Floor Cube (Ctrl+7)"
          >
            ⚖️ Shadow Pricing (#135)
            <span style={styles.keyShortcutBadge}>Ctrl+7</span>
          </button>
          <button
            type="button"
            style={styles.tabBtn(activeTab === "surveillance")}
            onClick={() => setActiveTab("surveillance")}
            title="Bun.dns latency benchmarks and surveillance markdown (Ctrl+2)"
          >
            📊 Telemetry
            <span style={styles.keyShortcutBadge}>Ctrl+2</span>
          </button>
          <button
            type="button"
            style={styles.tabBtn(activeTab === "terminal")}
            onClick={() => setActiveTab("terminal")}
            title="Native Bun.Terminal PTY query engine (Ctrl+3 or Cmd+K)"
          >
            💻 Terminal (PTY)
            <span style={styles.keyShortcutBadge}>Ctrl+3</span>
          </button>
          <button
            type="button"
            style={styles.tabBtn(activeTab === "rankings")}
            onClick={() => setActiveTab("rankings")}
            title="Rolling 30-day handle rankings & proxy conduits (Ctrl+4)"
          >
            🏆 Downlines ({PROXY_CONDUITS_30D.length})
            <span style={styles.keyShortcutBadge}>Ctrl+4</span>
          </button>
          <button
            type="button"
            style={{
              ...styles.tabBtn(activeTab === "wagers"),
              position: "relative",
            }}
            onClick={() => setActiveTab("wagers")}
            title="Real-time incoming wager tape with CLV alerts (Ctrl+5)"
          >
            ⚡ Live Wagers ({liveWagers.length})
            <span
              className="live-alert-pulse"
              style={{
                fontSize: "10px",
                padding: "1px 5px",
                borderRadius: "8px",
                backgroundColor: "#ef4444",
                color: "#ffffff",
                fontWeight: 700,
                marginLeft: "4px",
              }}
            >
              🚨{" "}
              {
                liveWagers.filter(
                  (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
                ).length
              }
            </span>
            <span style={styles.keyShortcutBadge}>Ctrl+5</span>
          </button>
          <button
            type="button"
            style={{
              ...styles.tabBtn(activeTab === "alerts"),
              position: "relative",
            }}
            onClick={() => {
              setActiveTab("alerts");
              fetchAlerts();
            }}
            title="Surveillance Alert Queue, Dead-Letter Queue (DLQ), and Replay Controls (Ctrl+6)"
          >
            🚨 DLQ & Alerts ({alertRecords.length})
            {healthData?.alerts?.dead && healthData.alerts.dead > 0 ? (
              <span
                style={{
                  fontSize: "10px",
                  padding: "1px 5px",
                  borderRadius: "8px",
                  backgroundColor: "#ef4444",
                  color: "#ffffff",
                  fontWeight: 700,
                  marginLeft: "4px",
                }}
              >
                {healthData.alerts.dead} DEAD
              </span>
            ) : null}
            <span style={styles.keyShortcutBadge}>Ctrl+6</span>
          </button>
          <button
            type="button"
            style={styles.tabBtn(activeTab === "bet-ticker")}
            onClick={() => setActiveTab("bet-ticker")}
          >
            📡 Bet Ticker (
            {betTickerData?.localFeed.actionableTicketCount ?? "…"})
            <span style={styles.keyShortcutBadge}>Ctrl+8</span>
          </button>
          <button
            type="button"
            style={styles.tabBtn(activeTab === "r2")}
            onClick={() => setActiveTab("r2")}
          >
            ☁️ R2 Pipeline
            {r2PipelineData?.staleKeys &&
            r2PipelineData.staleKeys.length > 0 ? (
              <span
                style={{
                  fontSize: "10px",
                  padding: "1px 5px",
                  borderRadius: "8px",
                  backgroundColor: "#f59e0b",
                  color: "#090d16",
                  fontWeight: 700,
                  marginLeft: "4px",
                }}
              >
                {r2PipelineData.staleKeys.length} STALE
              </span>
            ) : null}
            <span style={styles.keyShortcutBadge}>Ctrl+9</span>
          </button>
        </div>
      </header>

      {showBuildMatrix ? (
        <BuildMatrixDrawer
          dceMarker={runtimeFlags.dceMarker}
          loading={buildMatrixLoading}
          rows={buildMatrixRows}
        />
      ) : null}

      {/* Main View Area */}
      <main style={styles.main}>
        {activeTab === "customers" ? (
          <CustomersTabPanel
            unknownSyndicateCount={unknownSyndicateCount}
            bannerDismissed={bannerDismissed}
            onDismissBanner={() => {
              setBannerDismissed(true);
              try {
                sessionStorage.setItem("portalBannerDismissed", "1");
              } catch {}
            }}
            kpisCollapsed={kpisCollapsed}
            onToggleKpis={() => {
              const next = !kpisCollapsed;
              setKpisCollapsed(next);
              try {
                localStorage.setItem("kpisCollapsed", next ? "1" : "0");
              } catch {}
            }}
            cohortsReport={cohortsReport}
            cohortsStatus={cohortsStatus}
            cohortsError={cohortsError}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            filterTier={filterTier}
            onFilterTierChange={setFilterTier}
            sortedCustomers={sortedCustomers}
            customerSort={customerSort}
            onCustomerSort={onCustomerSort}
            selectedCustomer={selectedCustomer}
            onSelectCustomer={setSelectedCustomer}
            copiedCliId={copiedCliId}
            onCopyCli={(customerId) => {
              const cmd = `bun run cli -C ${customerId}`;
              void navigator.clipboard.writeText(cmd);
              setCopiedCliId(customerId);
              setTimeout(() => setCopiedCliId(null), 2000);
            }}
            customerForensicResult={customerForensicResult}
            onClearForensicResult={() => setCustomerForensicResult(null)}
            onRunReverseLookup={(ipAddress) => {
              void runReverseLookup(ipAddress);
            }}
            onOpenTerminalProfile={(customerId) => {
              setActiveTab("terminal");
              void runTerminalCommand(`profile ${customerId}`);
            }}
            onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
          />
        ) : activeTab === "surveillance" ? (
          <>
            <ThresholdsPanel />
            <SurveillanceTabPanel
              dnsData={dnsData}
              benchLoading={benchLoading}
              benchResult={benchResult}
              onRunBenchmark={() => {
                void runBenchmark();
              }}
              reverseIp={reverseIp}
              onReverseIpChange={setReverseIp}
              reverseResult={reverseResult}
              onRunReverseLookup={() => {
                void runReverseLookup();
              }}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              data={data}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
            />
          </>
        ) : activeTab === "terminal" ? (
          <TerminalTabPanel
            terminalCategory={terminalCategory}
            onTerminalCategoryChange={setTerminalCategory}
            terminalHistory={terminalHistory}
            onClearHistory={() => setTerminalHistory([])}
            copiedTerminalIdx={copiedTerminalIdx}
            onCopyOutput={(idx, stdout) => {
              void navigator.clipboard.writeText(stdout);
              setCopiedTerminalIdx(idx);
              setTimeout(() => setCopiedTerminalIdx(null), 1500);
            }}
            terminalLoading={terminalLoading}
            terminalBottomRef={terminalBottomRef}
            terminalCommand={terminalCommand}
            onTerminalCommandChange={setTerminalCommand}
            commandHistory={commandHistory}
            historyIndex={historyIndex}
            onHistoryIndexChange={setHistoryIndex}
            onAutocomplete={handleAutocomplete}
            onRunCommand={(cmd) => {
              void runTerminalCommand(cmd);
            }}
          />
        ) : activeTab === "rankings" ? (
          <RankingsTabPanel
            rankingsSearch={rankingsSearch}
            onRankingsSearchChange={setRankingsSearch}
            rankingsFilter={rankingsFilter}
            onRankingsFilterChange={setRankingsFilter}
            onInspectPty={(customerId) => {
              setActiveTab("terminal");
              void runTerminalCommand(`p ${customerId} --radar`);
            }}
            onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
            onSelectCustomerById={handleSelectCustomerById}
          />
        ) : activeTab === "alerts" ? (
          <AlertsTabPanel
            alertToast={alertToast}
            onDismissToast={() => setAlertToast(null)}
            onCopyDeliveryId={(deliveryId) => {
              void navigator.clipboard?.writeText(deliveryId);
              setAlertToast({
                message: `Copied delivery UUID: ${deliveryId}`,
                type: "info",
              });
            }}
            healthData={healthData}
            alertFilter={alertFilter}
            onFilterChange={(filter) => {
              setAlertFilter(filter);
              fetchAlerts(filter);
            }}
            alertLoading={alertLoading}
            onSweepAlerts={() => {
              void handleSweepAlerts();
            }}
            onRefreshAlerts={() => fetchAlerts(alertFilter)}
            onOpenShiftModal={() => {
              void fetchShiftSummary();
              setIsShiftModalOpen(true);
            }}
            alertRecords={alertRecords}
            tiersConfig={tiersConfig}
            onAckAlert={(deliveryId, notes) => {
              void handleAckAlert(deliveryId, notes);
            }}
            onRetryAlert={(deliveryId) => {
              void handleRetryAlert(deliveryId);
            }}
          />
        ) : activeTab === "shadow" ? (
          <ShadowPricingPanel
            onInspectAccount={(accountId) => {
              const found = profileRows.find(
                (c) => c.id.toUpperCase() === accountId.toUpperCase(),
              );
              if (found) {
                setSelectedCustomer(found);
              }
              setSearchQuery(accountId);
              setActiveTab("customers");
            }}
            onRunPtyCommand={(cmd) => {
              setActiveTab("terminal");
              void runTerminalCommand(cmd);
            }}
          />
        ) : activeTab === "bet-ticker" ? (
          <BetTickerTabPanel
            data={betTickerData}
            loading={betTickerLoading}
            error={betTickerError}
            onRefresh={() => {
              void fetchBetTicker();
            }}
            onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
            onSelectCustomerById={handleSelectCustomerById}
            onInspectPty={(customerId) => {
              setActiveTab("terminal");
              void runTerminalCommand(`profile ${customerId} --radar`);
            }}
          />
        ) : activeTab === "r2" ? (
          <R2PipelineTabPanel
            data={r2PipelineData}
            loading={r2PipelineLoading}
            error={r2PipelineError}
            onRefresh={(force) => {
              void fetchR2Pipeline(Boolean(force));
            }}
          />
        ) : (
          <LiveWagersTabPanel
            wagers={liveWagers}
            provenance={wagersProvenance}
            wagersError={wagersError}
            onRefreshWagers={() => {
              void fetchLiveWagers();
            }}
            wagerSearch={wagerSearch}
            onWagerSearchChange={setWagerSearch}
            wagerSportFilter={wagerSportFilter}
            onWagerSportFilterChange={setWagerSportFilter}
            wagerAlertFilter={wagerAlertFilter}
            onWagerAlertFilterChange={setWagerAlertFilter}
            wagerTypeFilter={wagerTypeFilter}
            onWagerTypeFilterChange={setWagerTypeFilter}
            wagerSortField={wagerSortField}
            wagerSortDir={wagerSortDir}
            onWagerSort={handleWagerSort}
            selectedWager={selectedWager}
            onSelectWager={setSelectedWager}
            copiedTicketId={copiedTicketId}
            onCopyText={(ticketId, text) => {
              void navigator.clipboard.writeText(text);
              setCopiedTicketId(ticketId);
              setTimeout(() => setCopiedTicketId(null), 1500);
            }}
            tiersConfig={tiersConfig}
            onSelectCustomerById={handleSelectCustomerById}
            onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
            onInspectPty={(customerId) => {
              setActiveTab("terminal");
              void runTerminalCommand(`profile ${customerId} --radar`);
            }}
          />
        )}
      </main>

      {/* Global Footer */}
      <footer style={styles.footer}>
        <span>Updated: {data?.updatedAt ?? "—"}</span>
        <span>
          Native Bun HTML Bundler + Bun.serve Routes + bun:bundle (
          {runtimeFlags.target}) + tokens.toml v1.1.0 · autoExecute: false
          invariant active
        </span>
      </footer>

      {selectedAgentId !== null && (
        <AgentInspectorModal
          agentId={selectedAgentId}
          onClose={() => setSelectedAgentId(null)}
          onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
          onSelectCustomerById={(customerId) => {
            setSelectedAgentId(null);
            handleSelectCustomerById(customerId);
          }}
          onInspectPty={(customerId) => {
            setSelectedAgentId(null);
            setActiveTab("terminal");
            void runTerminalCommand(`profile ${customerId} --radar`);
          }}
        />
      )}

      {/* Operator Shift Summary & Handoff Modal */}
      {isShiftModalOpen && (
        <ShiftHandoffModal
          shiftOperator={shiftOperator}
          onShiftOperatorChange={setShiftOperator}
          shiftLoading={shiftLoading}
          onRefresh={(operatorId) => {
            void fetchShiftSummary(operatorId);
          }}
          shiftSummary={shiftSummary}
          onClose={() => setIsShiftModalOpen(false)}
        />
      )}
    </div>
  );
}
