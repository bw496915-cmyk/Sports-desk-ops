import type React from "react";
import { useState } from "react";
import {
  DASHBOARD_API,
  DASHBOARD_FRESHNESS,
  DASHBOARD_LEAGUES,
  DASHBOARD_META,
  DASHBOARD_THRESHOLDS,
  dashboardApiUrl,
} from "../config/dashboard.ts";
import { styles } from "../dashboard_styles.ts";

export interface ThresholdsPanelProps {
  /** Optional live feed update ISO timestamp used for SLA freshness calculation. */
  readonly dataUpdatedAt?: string | null | undefined;
  /** Optional reference clock in epoch milliseconds for deterministic testing. */
  readonly nowMs?: number | undefined;
}

interface FreshnessSummary {
  readonly isStale: boolean;
  readonly sourceLabel: "feed" | "config";
  readonly ageLabel: string;
}

function formatElapsedMinutes(totalMinutes: number): string {
  if (totalMinutes < 1) return "<1m";
  const rounded = Math.round(totalMinutes);
  if (rounded < 60) return `${rounded}m`;
  const days = Math.floor(rounded / 1440);
  const hours = Math.floor((rounded % 1440) / 60);
  const mins = rounded % 60;
  if (days > 0) return `${days}d ${hours}h`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function computeFreshnessSummary(
  dataUpdatedAt: string | null | undefined,
  nowMs: number,
): FreshnessSummary {
  const sourceLabel = dataUpdatedAt ? "feed" : "config";
  const referenceIso = dataUpdatedAt || DASHBOARD_META.generated_at;
  const parsed = Date.parse(referenceIso);
  if (Number.isNaN(parsed)) {
    return { isStale: false, sourceLabel, ageLabel: "n/a" };
  }
  const ageMinutes = Math.max(0, (nowMs - parsed) / 60_000);
  return {
    isStale: ageMinutes > DASHBOARD_FRESHNESS.stale_after_minutes,
    sourceLabel,
    ageLabel: formatElapsedMinutes(ageMinutes),
  };
}

const API_ROUTE_ENTRIES: readonly (readonly [string, string])[] = [
  ["dashboard", DASHBOARD_API.dashboard],
  ["tiers", DASHBOARD_API.tiers],
  ["customers", DASHBOARD_API.customers],
  ["wagers", DASHBOARD_API.wagers],
];

/**
 * Renders the dispatch thresholds inlined from `config/dashboard.toml`.
 *
 * This read is what keeps the dashboard's tree-shake probe honest: the
 * `sharp` key is only present in the bundle because this component renders it.
 * If this panel is removed or stops reading a key, update REQUIRED_PROBE in
 * scripts/validate_dashboard_config.ts in the same change.
 */
export function ThresholdsPanel({
  dataUpdatedAt = null,
  nowMs = Date.now(),
}: ThresholdsPanelProps = {}): React.ReactElement {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const freshness = computeFreshnessSummary(dataUpdatedAt, nowMs);
  const steamPct = `${(DASHBOARD_THRESHOLDS.steam * 100).toFixed(1)}%`;

  return (
    <div
      style={{
        ...styles.dnsBar,
        flexDirection: "column",
        alignItems: "stretch",
        gap: "10px",
        borderLeft: `3px solid ${freshness.isStale ? "#f59e0b" : "#10b981"}`,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "10px 16px",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={styles.dnsLabel}>⚙ Dispatch thresholds:</span>
          <span
            title={`Evaluating ${freshness.sourceLabel} timestamp against ${DASHBOARD_FRESHNESS.stale_after_minutes}m SLA window`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: "999px",
              fontSize: "11px",
              fontWeight: 700,
              color: freshness.isStale ? "#fbbf24" : "#34d399",
              backgroundColor: freshness.isStale
                ? "rgba(245, 158, 11, 0.16)"
                : "rgba(16, 185, 129, 0.14)",
              border: `1px solid ${
                freshness.isStale
                  ? "rgba(251, 191, 36, 0.4)"
                  : "rgba(52, 211, 153, 0.4)"
              }`,
            }}
          >
            {freshness.isStale ? "STALE" : "FRESH"} · {freshness.sourceLabel}{" "}
            {freshness.ageLabel}
          </span>
        </div>

        <span
          title="Minimum composite sharp-action score required to dispatch alerts"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: "#091020",
            border: "1px solid #1e293b",
          }}
        >
          Sharp:{" "}
          <b style={{ color: "#f8fafc" }}>{DASHBOARD_THRESHOLDS.sharp}</b>
          <span style={{ color: "#64748b", fontSize: "11px" }}>
            (&ge; score gate)
          </span>
        </span>

        <span
          title="Minimum implied-probability / line movement delta flagged as steam"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: "#091020",
            border: "1px solid #1e293b",
          }}
        >
          Steam:{" "}
          <b style={{ color: "#f8fafc" }}>{DASHBOARD_THRESHOLDS.steam}</b>
          <span style={{ color: "#64748b", fontSize: "11px" }}>
            ({steamPct} delta)
          </span>
        </span>

        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "6px",
          }}
        >
          <span>Leagues ({DASHBOARD_LEAGUES.names.length}):</span>
          {DASHBOARD_LEAGUES.names.map((league) => (
            <span
              key={league}
              style={{
                padding: "1px 7px",
                borderRadius: "999px",
                backgroundColor: "rgba(56, 189, 248, 0.12)",
                border: "1px solid rgba(56, 189, 248, 0.3)",
                color: "#e2e8f0",
                fontWeight: 700,
                fontSize: "11px",
              }}
            >
              {league}
            </span>
          ))}
        </span>

        <div
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <span style={styles.dnsLabel}>
            config {DASHBOARD_META.generated_at.slice(0, 10)} · stale &gt;
            {DASHBOARD_FRESHNESS.stale_after_minutes}m
          </span>
          <button
            type="button"
            onClick={() => setDetailsOpen((prev) => !prev)}
            style={{
              padding: "3px 8px",
              borderRadius: "4px",
              backgroundColor: "rgba(56, 189, 248, 0.1)",
              color: "#7dd3fc",
              fontSize: "11px",
              fontWeight: 600,
              border: "1px solid rgba(56, 189, 248, 0.3)",
              cursor: "pointer",
            }}
          >
            {detailsOpen ? "▴ Config SSOT" : "▾ Config SSOT"}
          </button>
        </div>
      </div>

      {detailsOpen && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 16px",
            paddingTop: "8px",
            borderTop: "1px solid #1e293b",
            fontSize: "11px",
            color: "#94a3b8",
          }}
        >
          <span>
            Snapshot:{" "}
            <code style={{ color: "#e2e8f0" }}>
              {DASHBOARD_META.generated_at}
            </code>
          </span>
          <span>
            API base:{" "}
            <code style={{ color: "#e2e8f0" }}>
              {DASHBOARD_API.base || "same-origin"}
            </code>
          </span>
          {API_ROUTE_ENTRIES.map(([name, routePath]) => (
            <span key={name}>
              {name}:{" "}
              <code style={{ color: "#7dd3fc" }}>
                {dashboardApiUrl(routePath)}
              </code>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
