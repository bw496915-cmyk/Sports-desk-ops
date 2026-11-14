import type React from "react";
import { styles } from "../dashboard_styles.ts";
import { DASHBOARD_FRESHNESS } from "../config/dashboard.ts";
import {
  deriveCustomerCohortKpiCards,
  formatProvenanceBadge,
  PENDING_COHORTS_PROVENANCE,
} from "../hydration.ts";
import { getLocalAgentHref } from "../links.ts";
import type {
  CustomersApiResponse,
  CustomerSortKey,
  ShowcaseCustomer,
} from "../types.ts";

export interface CustomersTabPanelProps {
  readonly bannerDismissed: boolean;
  readonly onDismissBanner: () => void;
  readonly kpisCollapsed: boolean;
  readonly onToggleKpis: () => void;
  readonly cohortsReport?: CustomersApiResponse | null | undefined;
  readonly cohortsStatus?: "pending" | "ready" | "unavailable" | undefined;
  readonly cohortsError?: string | null | undefined;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (value: string) => void;
  readonly filterTier: string;
  readonly onFilterTierChange: (tier: string) => void;
  readonly sortedCustomers: readonly ShowcaseCustomer[];
  readonly customerSort: {
    readonly key: CustomerSortKey;
    readonly dir: 1 | -1;
  };
  readonly onCustomerSort: (key: CustomerSortKey) => void;
  readonly selectedCustomer: ShowcaseCustomer | null;
  readonly onSelectCustomer: (cust: ShowcaseCustomer) => void;
  readonly copiedCliId: string | null;
  readonly onCopyCli: (customerId: string) => void;
  readonly customerForensicResult: string | null;
  readonly onClearForensicResult: () => void;
  readonly onRunReverseLookup: (ipAddress: string) => void;
  readonly onOpenTerminalProfile: (customerId: string) => void;
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
  /** Rows the Syndicates filter hides because the book carries no syndicate signal. */
  readonly unknownSyndicateCount?: number | undefined;
}

interface CustomerCohortSummary {
  readonly totalVarUsd: number;
  readonly totalCapUsd: number;
  readonly alertCount: number;
  readonly avgSharpness: string;
}

function summarizeDisplayedCustomers(
  rows: readonly ShowcaseCustomer[],
): CustomerCohortSummary {
  let totalVarUsd = 0;
  let totalCapUsd = 0;
  let alertCount = 0;
  let sharpSum = 0;
  let sharpCount = 0;
  for (const row of rows) {
    totalVarUsd += row.var95Usd;
    totalCapUsd += row.recommendedLimitUsd;
    if (row.action.includes("ALERT")) alertCount++;
    if (!row.unknown?.includes("sharpness")) {
      sharpSum += row.score;
      sharpCount++;
    }
  }
  return {
    totalVarUsd,
    totalCapUsd,
    alertCount,
    avgSharpness: sharpCount > 0 ? (sharpSum / sharpCount).toFixed(1) : "n/a",
  };
}

interface RadarAxisSpec {
  readonly label: string;
  readonly valueKey:
    "clvScore" | "skillScore" | "sizingScore" | "sigScore" | "timingScore";
  readonly max: number;
  readonly color: string;
}

const RADAR_AXES: readonly RadarAxisSpec[] = [
  {
    label: "CLV Beat Margin",
    valueKey: "clvScore",
    max: 3.0,
    color: "#38bdf8",
  },
  {
    label: "Bayesian Skill",
    valueKey: "skillScore",
    max: 2.5,
    color: "#a855f7",
  },
  {
    label: "Sizing Discipline",
    valueKey: "sizingScore",
    max: 1.5,
    color: "#22c55e",
  },
  {
    label: "Signature Specialization",
    valueKey: "sigScore",
    max: 2.0,
    color: "#f59e0b",
  },
  {
    label: "Timing / Parlay Exploitation",
    valueKey: "timingScore",
    max: 1.0,
    color: "#ef4444",
  },
];

export function CustomersTabPanel({
  bannerDismissed,
  onDismissBanner,
  kpisCollapsed,
  onToggleKpis,
  cohortsReport = null,
  cohortsStatus,
  cohortsError = null,
  searchQuery,
  onSearchQueryChange,
  filterTier,
  onFilterTierChange,
  sortedCustomers,
  customerSort,
  onCustomerSort,
  selectedCustomer,
  onSelectCustomer,
  copiedCliId,
  onCopyCli,
  customerForensicResult,
  onClearForensicResult,
  onRunReverseLookup,
  onOpenTerminalProfile,
  onSelectAgent,
  unknownSyndicateCount = 0,
}: CustomersTabPanelProps): React.ReactElement {
  const effectiveStatus: "pending" | "ready" | "unavailable" =
    cohortsStatus ?? (cohortsReport !== null ? "ready" : "pending");
  const kpiCards = deriveCustomerCohortKpiCards({
    report: cohortsReport,
    status: effectiveStatus,
    error: cohortsError,
  });
  const provenanceBadge = formatProvenanceBadge(
    effectiveStatus === "unavailable"
      ? {
          kind: "unavailable",
          label: cohortsError || "GET /api/customers failed",
          sourcePath: "/api/customers",
          observedAt: "",
        }
      : (cohortsReport?.provenance ?? PENDING_COHORTS_PROVENANCE),
    { staleAfterMinutes: DASHBOARD_FRESHNESS.stale_after_minutes },
  );

  return (
    <div>
      {/* Session Notice Banner (Dismissible) */}
      {!bannerDismissed && (
        <div
          style={{
            marginBottom: "16px",
            padding: "10px 14px",
            borderRadius: "8px",
            background: "rgba(245, 158, 11, 0.1)",
            border: "1px solid rgba(245, 158, 11, 0.2)",
            fontSize: "12px",
            color: "#fbbf24",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
            }}
          >
            <span style={{ fontSize: "16px", lineHeight: "1" }}>⚠️</span>
            <div>
              <b>Fantasy402 Portal Session Notice:</b> Direct portal links
              require an active, authenticated manager session in your browser.
              If you encounter <i>"Your session has expired"</i>, log into
              fantasy402.com first. For instant local telemetry, all accounts
              are profiled below; click any row/ID to inspect or use{" "}
              <b>📋 Copy CLI</b>.
            </div>
          </div>
          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              color: "#fbbf24",
              fontSize: "16px",
              cursor: "pointer",
              padding: "0 4px",
              lineHeight: "1",
            }}
            onClick={onDismissBanner}
            title="Dismiss notice"
          >
            ✕
          </button>
        </div>
      )}

      {/* Collapsible KPI Strip Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "11px",
              color: "#64748b",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontWeight: 600,
            }}
          >
            Corpora & Surveillance Cohorts
          </span>
          <span
            title={provenanceBadge.detail}
            style={{
              fontSize: "10px",
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: "999px",
              color: provenanceBadge.fg,
              backgroundColor: provenanceBadge.bg,
              border: `1px solid ${provenanceBadge.border}`,
            }}
          >
            {provenanceBadge.badgeText}
          </span>
          {cohortsReport?.provenance.sourcePath ? (
            <span style={{ fontSize: "10px", color: "#64748b" }}>
              {cohortsReport.provenance.sourcePath}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            color: "#38bdf8",
            fontSize: "11px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 6px",
          }}
          onClick={onToggleKpis}
        >
          {kpisCollapsed ? "Show Corpora ▼" : "Hide Corpora ▲"}
        </button>
      </div>

      {/* KPI Summary Cards (Collapsible, hydrated dynamically from /api/customers) */}
      {!kpisCollapsed && (
        <div className="kpi-strip" style={styles.kpiGrid}>
          {kpiCards.map((card) => (
            <div key={card.label} style={styles.kpiCard}>
              <div style={styles.kpiLabel}>{card.label}</div>
              <div style={styles.kpiVal}>{card.value}</div>
              <div style={styles.kpiSub}>{card.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filter and Search Bar */}
      <div style={styles.filterBar}>
        <input
          style={styles.searchInput}
          placeholder="🔍 Search by Customer ID, Name, Agent or Sport..."
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
        />
        <div style={styles.filterPills}>
          <button
            type="button"
            style={styles.pill(filterTier === "ALL")}
            onClick={() => onFilterTierChange("ALL")}
          >
            All Profiles
          </button>
          <button
            type="button"
            style={styles.pill(filterTier === "ELITE")}
            onClick={() => onFilterTierChange("ELITE")}
          >
            🚨 Elite Sharps
          </button>
          <button
            type="button"
            style={styles.pill(filterTier === "SYNDICATE")}
            onClick={() => onFilterTierChange("SYNDICATE")}
          >
            🔗 Syndicates
          </button>
          <button
            type="button"
            style={styles.pill(filterTier === "STEAM")}
            onClick={() => onFilterTierChange("STEAM")}
          >
            ⚡ Steam Chasers
          </button>
          <button
            type="button"
            style={styles.pill(filterTier === "RECREATIONAL")}
            onClick={() => onFilterTierChange("RECREATIONAL")}
          >
            ✅ High-Hold Whales
          </button>
        </div>
      </div>

      {/* Two-Column Grid: Customer Table & Deep Inspector */}
      {(() => {
        const cohortSummary = summarizeDisplayedCustomers(sortedCustomers);
        const hasActiveFilter =
          searchQuery.trim() !== "" || filterTier !== "ALL";
        const selectedIndex = selectedCustomer
          ? sortedCustomers.findIndex((c) => c.id === selectedCustomer.id)
          : -1;
        const canStepPrev = selectedIndex > 0;
        const canStepNext =
          selectedIndex >= 0 && selectedIndex < sortedCustomers.length - 1;
        const resetFilters = () => {
          onSearchQueryChange("");
          onFilterTierChange("ALL");
        };
        const stepCustomer = (delta: -1 | 1) => {
          if (sortedCustomers.length === 0) return;
          const nextIdx =
            selectedIndex < 0
              ? 0
              : Math.min(
                  sortedCustomers.length - 1,
                  Math.max(0, selectedIndex + delta),
                );
          const next = sortedCustomers[nextIdx];
          if (next) {
            onSelectCustomer(next);
            onClearForensicResult();
          }
        };

        return (
          <div style={styles.showcaseGrid}>
            {/* Left Column: Customers Table */}
            <div style={styles.tablePanel}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "8px 12px",
                  marginBottom: "10px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    flexWrap: "wrap",
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: "16px", color: "#f8fafc" }}>
                    Profiled Bettors ({sortedCustomers.length})
                  </h3>
                  <span
                    style={{
                      padding: "2px 7px",
                      borderRadius: "4px",
                      backgroundColor: "rgba(56, 189, 248, 0.12)",
                      color: "#7dd3fc",
                      fontSize: "11px",
                      fontWeight: 600,
                    }}
                  >
                    Avg Sharp: {cohortSummary.avgSharpness}
                  </span>
                  <span
                    style={{
                      padding: "2px 7px",
                      borderRadius: "4px",
                      backgroundColor: "rgba(239, 68, 68, 0.14)",
                      color: "#fca5a5",
                      fontSize: "11px",
                      fontWeight: 600,
                    }}
                  >
                    {cohortSummary.alertCount} Alerts
                  </span>
                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                    Σ VaR: <b>${cohortSummary.totalVarUsd.toLocaleString()}</b>{" "}
                    · Σ Caps:{" "}
                    <b>${cohortSummary.totalCapUsd.toLocaleString()}</b>
                  </span>
                </div>
                <div
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  {hasActiveFilter && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      style={{
                        padding: "2px 8px",
                        borderRadius: "4px",
                        backgroundColor: "rgba(245, 158, 11, 0.14)",
                        border: "1px solid rgba(251, 191, 36, 0.35)",
                        color: "#fbbf24",
                        fontSize: "11px",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      ✕ Reset filters
                    </button>
                  )}
                  <span style={{ fontSize: "11px", color: "#64748b" }}>
                    Click header to sort · Pinned Directive
                  </span>
                </div>
                {filterTier === "SYNDICATE" && unknownSyndicateCount > 0 && (
                  <span style={{ fontSize: "11px", color: "#fbbf24" }}>
                    {unknownSyndicateCount} excluded: syndicate signal unknown
                  </span>
                )}
              </div>
              <div className="profiles-wrap">
                <table style={styles.table}>
                  <thead>
                    <tr style={styles.thRow}>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("id")}
                      >
                        Customer
                        <span className="sort-arrow">
                          {customerSort.key === "id"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("score")}
                      >
                        Unified Sharpness
                        <span className="sort-arrow">
                          {customerSort.key === "score"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("gini")}
                      >
                        Sizing Strategy
                        <span className="sort-arrow">
                          {customerSort.key === "gini"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th style={styles.th}>Specialization</th>
                      <th style={styles.th}>Correlated Par</th>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("var95Usd")}
                      >
                        7d VaR (95%)
                        <span className="sort-arrow">
                          {customerSort.key === "var95Usd"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th
                        className="sortable directive"
                        style={styles.th}
                        onClick={() => onCustomerSort("holdPct")}
                      >
                        Desk Directive
                        <span className="sort-arrow">
                          {customerSort.key === "holdPct"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCustomers.map((cust) => {
                      const isSelected = selectedCustomer?.id === cust.id;
                      const tierClass = cust.tier.includes("TIER_1")
                        ? "tier-1"
                        : cust.tier.includes("TIER_2")
                          ? "tier-2"
                          : cust.tier.includes("TIER_3")
                            ? "tier-3"
                            : cust.tier.includes("TIER_4")
                              ? "tier-4"
                              : "tier-5";

                      const actionClass = cust.action.includes("ALERT")
                        ? "action-alert"
                        : cust.action.includes("MONITOR") ||
                            cust.action.includes("THROTTLE")
                          ? "action-monitor"
                          : "action-accept";

                      return (
                        <tr
                          key={cust.id}
                          style={styles.tr(isSelected)}
                          onClick={() => {
                            onSelectCustomer(cust);
                            onClearForensicResult();
                          }}
                        >
                          <td style={styles.td}>
                            <div style={styles.custCell}>
                              <span
                                style={{
                                  ...styles.custLink,
                                  cursor: "pointer",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectCustomer(cust);
                                  onClearForensicResult();
                                }}
                              >
                                {cust.id}
                              </span>
                              <a
                                href={`https://fantasy402.com/manager.html?customer=${cust.id}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  color: "#94a3b8",
                                  textDecoration: "none",
                                  fontSize: "11px",
                                }}
                                onClick={(e) => e.stopPropagation()}
                                title="Open in Fantasy402 Manager Portal"
                              >
                                ↗
                              </a>
                              {cust.subAccountIndex !== null && (
                                <span style={styles.subBadge}>
                                  Seat #{cust.subAccountIndex}
                                </span>
                              )}
                            </div>
                            <div style={styles.custAgent}>
                              Agent:{" "}
                              <a
                                href={getLocalAgentHref(cust.agentId)}
                                style={{
                                  color: "#38bdf8",
                                  textDecoration: "none",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (
                                    onSelectAgent &&
                                    !e.metaKey &&
                                    !e.ctrlKey &&
                                    e.button === 0
                                  ) {
                                    e.preventDefault();
                                    onSelectAgent(cust.agentId);
                                  }
                                }}
                                title="Open SportsDesk Agent Inspector"
                              >
                                {cust.agentId} ↗
                              </a>
                            </div>
                          </td>
                          <td style={styles.td}>
                            <span className={`chip ${tierClass}`}>
                              {cust.score >= 9.0
                                ? "🚨 "
                                : cust.score >= 8.0
                                  ? "⚡ "
                                  : cust.score >= 7.0
                                    ? "⚠️ "
                                    : "✅ "}
                              {cust.unknown?.includes("sharpness")
                                ? "—"
                                : cust.score.toFixed(1)}{" "}
                              ·{" "}
                              {cust.unknown?.includes("sharpness")
                                ? "UNKNOWN"
                                : cust.tier.replace("TIER_", "T")}
                            </span>
                          </td>
                          <td style={styles.td}>
                            {cust.unknown?.includes("sizing") ? (
                              <div
                                style={{ color: "#64748b", fontSize: "11px" }}
                                title="Sample book row omits stake-sizing series"
                              >
                                UNMEASURED
                              </div>
                            ) : (
                              <div>{cust.sizingStrategy}</div>
                            )}
                            <div style={styles.custSub}>
                              Gini:{" "}
                              {cust.unknown?.includes("gini")
                                ? "n/a"
                                : cust.gini.toFixed(3)}
                            </div>
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              maxWidth: "168px",
                              whiteSpace: "normal",
                              overflowWrap: "anywhere",
                            }}
                          >
                            <div>{cust.specialization}</div>
                            <div style={styles.custSub}>
                              {cust.timingArchetype}
                            </div>
                          </td>
                          <td style={styles.td}>
                            <span style={styles.corrBadge(cust.correlatedRisk)}>
                              {cust.correlatedRisk}
                            </span>
                          </td>
                          <td style={styles.td}>
                            <div>${cust.var95Usd.toLocaleString()}</div>
                            <div
                              className={
                                cust.holdPct < 0 ? "hold-neg" : "hold-pos"
                              }
                              style={{ fontSize: "11px" }}
                            >
                              Hold: {cust.holdPct}%
                            </div>
                          </td>
                          <td className="directive" style={styles.td}>
                            <span className={`chip ${actionClass}`}>
                              {cust.action}
                            </span>
                            <div style={styles.custSub}>
                              Cap: ${cust.recommendedLimitUsd.toLocaleString()}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {sortedCustomers.length === 0 && (
                      <tr>
                        <td
                          colSpan={7}
                          style={{
                            padding: "24px 16px",
                            textAlign: "center",
                            color: "#94a3b8",
                            fontSize: "12px",
                          }}
                        >
                          No profiled bettors match current filters.{" "}
                          {hasActiveFilter && (
                            <button
                              type="button"
                              onClick={resetFilters}
                              style={{
                                marginLeft: "8px",
                                padding: "3px 10px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(56, 189, 248, 0.16)",
                                border: "1px solid rgba(56, 189, 248, 0.4)",
                                color: "#7dd3fc",
                                fontSize: "11px",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              Reset filters
                            </button>
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right Column: Deep-Dive Inspector */}
            <div className="detail-panel" style={styles.inspectorPanel}>
              {selectedCustomer ? (
                <div>
                  <div style={styles.inspectorHeader}>
                    <div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <h2 style={styles.inspectorTitle}>
                          {selectedCustomer.id}
                        </h2>
                        {selectedIndex >= 0 && (
                          <span
                            style={{
                              padding: "1px 7px",
                              borderRadius: "999px",
                              backgroundColor: "#1e293b",
                              color: "#94a3b8",
                              fontSize: "11px",
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                            }}
                          >
                            #{selectedIndex + 1} / {sortedCustomers.length}
                          </span>
                        )}
                      </div>
                      <div style={styles.inspectorSub}>
                        {selectedCustomer.name} · Agent:{" "}
                        <b>{selectedCustomer.agentId}</b> (Master:{" "}
                        <b>{selectedCustomer.masterAgent}</b>)
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        justifyContent: "flex-start",
                        alignItems: "center",
                        gap: "6px",
                        maxWidth: "100%",
                      }}
                    >
                      <button
                        type="button"
                        disabled={!canStepPrev}
                        onClick={() => stepCustomer(-1)}
                        style={{
                          padding: "4px 7px",
                          borderRadius: "4px",
                          backgroundColor: "#1e293b",
                          color: canStepPrev ? "#e2e8f0" : "#475569",
                          border: "1px solid #334155",
                          fontSize: "11px",
                          cursor: canStepPrev ? "pointer" : "default",
                        }}
                        title="Previous customer in current sort order"
                      >
                        ← Prev
                      </button>
                      <button
                        type="button"
                        disabled={!canStepNext}
                        onClick={() => stepCustomer(1)}
                        style={{
                          padding: "4px 7px",
                          borderRadius: "4px",
                          backgroundColor: "#1e293b",
                          color: canStepNext ? "#e2e8f0" : "#475569",
                          border: "1px solid #334155",
                          fontSize: "11px",
                          cursor: canStepNext ? "pointer" : "default",
                        }}
                        title="Next customer in current sort order"
                      >
                        Next →
                      </button>
                      <button
                        type="button"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                        onClick={() =>
                          onOpenTerminalProfile(selectedCustomer.id)
                        }
                        title="Inspect this customer in Bun.Terminal emulator"
                      >
                        💻 Terminal
                      </button>
                      <button
                        type="button"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                        onClick={() => onCopyCli(selectedCustomer.id)}
                        title="Copy terminal CLI command to clipboard"
                      >
                        {copiedCliId === selectedCustomer.id
                          ? "✓ Copied CLI"
                          : "📋 Copy CLI"}
                      </button>
                      <a
                        href={`https://fantasy402.com/manager.html?customer=${selectedCustomer.id}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          textDecoration: "none",
                          color: "#0f172a",
                        }}
                        title="Requires active Fantasy402 manager session in your browser"
                      >
                        Portal ↗
                      </a>
                      <span style={styles.tierBadge(selectedCustomer.tier)}>
                        {selectedCustomer.tier} (Score:{" "}
                        {selectedCustomer.unknown?.includes("sharpness")
                          ? "—"
                          : selectedCustomer.score.toFixed(1)}
                        /10.0)
                      </span>
                    </div>
                  </div>

                  {/* Decomposed Score Progress Bars */}
                  <div style={styles.radarCard}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <h4 style={styles.cardHeader}>
                        🎯 Decomposed Sharpness Radars
                      </h4>
                      <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                        Sum:{" "}
                        <b style={{ color: "#f8fafc" }}>
                          {(
                            selectedCustomer.clvScore +
                            selectedCustomer.skillScore +
                            selectedCustomer.sizingScore +
                            selectedCustomer.sigScore +
                            selectedCustomer.timingScore
                          ).toFixed(1)}
                        </b>
                        /10.0
                      </span>
                    </div>
                    {RADAR_AXES.map((axis) => {
                      const val = selectedCustomer[axis.valueKey];
                      const pct = Math.min(
                        100,
                        Math.max(0, (val / axis.max) * 100),
                      );
                      return (
                        <div key={axis.valueKey} style={styles.radarRow}>
                          <span>
                            {axis.label} ({val.toFixed(1)}/{axis.max.toFixed(1)}
                            ):
                          </span>
                          <div style={styles.progressBarBg}>
                            <div
                              style={styles.progressBarFill(pct, axis.color)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Sizing & Portfolio Risk */}
                  <div style={styles.detailGrid}>
                    <div style={styles.detailCard}>
                      <h4 style={styles.cardHeader}>
                        💰 Stake Sizing & Variance
                      </h4>
                      <div>
                        Strategy: <b>{selectedCustomer.sizingStrategy}</b>
                      </div>
                      <div>
                        Gini Inequality:{" "}
                        <b>
                          {selectedCustomer.unknown?.includes("gini")
                            ? "n/a"
                            : selectedCustomer.gini}
                        </b>
                      </div>
                      <div>
                        Mean Stake:{" "}
                        <b>
                          {selectedCustomer.unknown?.includes("meanStake")
                            ? "n/a"
                            : `$${selectedCustomer.meanStake.toLocaleString()}`}
                        </b>
                      </div>
                      <div>
                        VaR / Max Cap:{" "}
                        <b
                          style={{
                            color:
                              selectedCustomer.recommendedLimitUsd > 0 &&
                              selectedCustomer.var95Usd >
                                selectedCustomer.recommendedLimitUsd
                                ? "#f87171"
                                : "#7dd3fc",
                          }}
                        >
                          {selectedCustomer.recommendedLimitUsd > 0
                            ? `${Math.round((selectedCustomer.var95Usd / selectedCustomer.recommendedLimitUsd) * 100)}%`
                            : "n/a"}
                        </b>
                      </div>
                    </div>
                    <div style={styles.detailCard}>
                      <h4 style={styles.cardHeader}>
                        📊 Risk & Expected Value
                      </h4>
                      <div>
                        7d 95% VaR:{" "}
                        <b>${selectedCustomer.var95Usd.toLocaleString()}</b>
                      </div>
                      <div>
                        Expected Shortfall (CVaR):{" "}
                        <b>${selectedCustomer.cvar95Usd.toLocaleString()}</b>
                      </div>
                      <div>
                        Lifetime Hold:{" "}
                        <b
                          style={{
                            color:
                              selectedCustomer.holdPct < 0
                                ? "#f87171"
                                : "#4ade80",
                          }}
                        >
                          {selectedCustomer.holdPct}%
                        </b>
                      </div>
                      <div>
                        Projected LTV:{" "}
                        <b>
                          ${Math.abs(selectedCustomer.ltvUsd).toLocaleString()}
                          {selectedCustomer.ltvUsd < 0
                            ? " (Loss to Desk)"
                            : " (Desk Hold)"}
                        </b>
                      </div>
                    </div>
                  </div>

                  {/* Correlated Parlay & Timing */}
                  <div style={styles.detailGrid}>
                    <div style={styles.detailCard}>
                      <h4 style={styles.cardHeader}>🔗 Correlated Parlays</h4>
                      <div>
                        Risk Tier:{" "}
                        <span
                          style={styles.corrBadge(
                            selectedCustomer.correlatedRisk,
                          )}
                        >
                          {selectedCustomer.correlatedRisk}
                        </span>
                      </div>
                      <div>
                        Exploit Rate:{" "}
                        <b>
                          {(
                            selectedCustomer.correlatedExploitRate * 100
                          ).toFixed(0)}
                          %
                        </b>
                      </div>
                    </div>
                    <div style={styles.detailCard}>
                      <h4 style={styles.cardHeader}>⏱️ Timing Fingerprint</h4>
                      <div>
                        Archetype: <b>{selectedCustomer.timingArchetype}</b>
                      </div>
                      <div>
                        Downline Syndicate:{" "}
                        <b>
                          {(selectedCustomer.syndicateProb * 100).toFixed(0)}%
                          Prob
                        </b>
                      </div>
                    </div>
                  </div>

                  {/* Actionable Operator Directives */}
                  <div style={styles.directiveCard}>
                    <h4 style={styles.cardHeader}>
                      🚨 Actionable Desk Directives
                    </h4>
                    <div style={styles.directiveRow}>
                      <span>Action:</span>
                      <span style={styles.actionBadge(selectedCustomer.action)}>
                        {selectedCustomer.action}
                      </span>
                    </div>
                    <div style={styles.directiveRow}>
                      <span>Max Stake Ceiling:</span>
                      <b>
                        ${selectedCustomer.recommendedLimitUsd.toLocaleString()}
                      </b>
                    </div>
                    <div style={styles.directiveRow}>
                      <span>In-Play Submission Delay:</span>
                      <b>{selectedCustomer.inPlayDelaySec} seconds</b>
                    </div>
                    <div style={styles.directiveRow}>
                      <span>Line Shading:</span>
                      <b>{selectedCustomer.lineShadeCents}¢ against action</b>
                    </div>
                    <div style={styles.directiveRow}>
                      <span>Shadow Copy Multiplier:</span>
                      <b>{selectedCustomer.shadowCopyMultiplier.toFixed(2)}x</b>
                    </div>
                  </div>

                  {/* Real-time Reverse DNS Forensics Trigger */}
                  <div style={styles.forensicCard}>
                    <h4 style={styles.cardHeader}>
                      🌐 Reverse DNS & Proxy Forensics
                    </h4>
                    <div style={styles.forensicRow}>
                      <span>Observed Login IP:</span>
                      <code>{selectedCustomer.ipAddress}</code>
                      <button
                        type="button"
                        style={styles.actionBtnSmall}
                        onClick={() =>
                          onRunReverseLookup(selectedCustomer.ipAddress)
                        }
                      >
                        🔍 Run Reverse DNS
                      </button>
                    </div>
                    {customerForensicResult && (
                      <div style={styles.forensicResult}>
                        {customerForensicResult}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div style={styles.loading}>
                  Select a customer to inspect deep multidimensional profile.
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
