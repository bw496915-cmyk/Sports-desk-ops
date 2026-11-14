import type React from "react";
import { DASHBOARD_PANELS } from "../config/dashboard.ts";
import { styles } from "../dashboard_styles.ts";
import type { DashboardData, DnsData } from "../types.ts";
import { ThresholdsPanel } from "./ThresholdsPanel.tsx";

export interface SurveillanceTabPanelProps {
  readonly dnsData: DnsData | null;
  readonly benchLoading: boolean;
  readonly benchResult: string | null;
  readonly onRunBenchmark: () => void;
  readonly reverseIp: string;
  readonly onReverseIpChange: (value: string) => void;
  readonly reverseResult: string | null;
  readonly onRunReverseLookup: () => void;
  readonly viewMode: "interactive" | "raw";
  readonly onViewModeChange: (mode: "interactive" | "raw") => void;
  readonly data: DashboardData | null;
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
}

export function SurveillanceTabPanel({
  dnsData,
  benchLoading,
  benchResult,
  onRunBenchmark,
  reverseIp,
  onReverseIpChange,
  reverseResult,
  onRunReverseLookup,
  viewMode,
  onViewModeChange,
  data,
  onSelectAgent,
}: SurveillanceTabPanelProps): React.ReactElement {
  return (
    <div>
      {/* Existing Surveillance & Telemetry View */}
      {dnsData && (
        <div style={styles.dnsBar}>
          <span style={styles.dnsLabel}>🌐 Bun.dns Cache Telemetry:</span>
          <span>
            Size:{" "}
            <b>
              {dnsData.telemetry.size}/{DASHBOARD_PANELS.dns_cache_capacity}
            </b>
          </span>
          <span>
            Hit Rate: <b>{dnsData.telemetry.hitRatePercent}%</b>
          </span>
          <span>
            Hits (Completed): <b>{dnsData.telemetry.cacheHitsCompleted}</b>
          </span>
          <span>
            Hits (Inflight): <b>{dnsData.telemetry.cacheHitsInflight}</b>
          </span>
          <span>
            Misses: <b>{dnsData.telemetry.cacheMisses}</b>
          </span>
          <span>
            TTL: <b>{dnsData.telemetry.defaultTtlSeconds}s</b>
          </span>
        </div>
      )}

      <div style={styles.toolsBar}>
        <div style={styles.toolItem}>
          <button
            type="button"
            style={styles.actionBtn}
            onClick={onRunBenchmark}
            disabled={benchLoading}
          >
            {benchLoading
              ? "Benchmarking..."
              : "⚡ Benchmark c-ares vs system (fantasy402.com)"}
          </button>
          {benchResult && <span style={styles.toolResult}>{benchResult}</span>}
        </div>
        <div style={styles.toolItem}>
          <input
            style={styles.input}
            value={reverseIp}
            onChange={(e) => onReverseIpChange(e.target.value)}
            placeholder="IP (e.g. 1.1.1.1)"
          />
          <button
            type="button"
            style={styles.actionBtn}
            onClick={onRunReverseLookup}
          >
            🔍 Reverse DNS & Forensics
          </button>
          {reverseResult && (
            <span style={styles.toolResult}>{reverseResult}</span>
          )}
        </div>
        <div style={styles.viewToggleGroup}>
          <button
            type="button"
            style={styles.toggleBtn(viewMode === "interactive")}
            onClick={() => onViewModeChange("interactive")}
          >
            Interactive
          </button>
          <button
            type="button"
            style={styles.toggleBtn(viewMode === "raw")}
            onClick={() => onViewModeChange("raw")}
          >
            Raw Markdown
          </button>
        </div>
      </div>

      <ThresholdsPanel />

      {data ? (
        viewMode === "interactive" ? (
          <div
            style={styles.renderedHtml}
            onClick={(e) => {
              if (!onSelectAgent) return;
              const target = e.target as HTMLElement | null;
              const anchor = target?.closest?.("a");
              if (!anchor) return;
              const href = anchor.getAttribute("href") ?? "";
              const agentMatch = /^\/agent\/([^/?#]+)/i.exec(href);
              if (
                agentMatch?.[1] &&
                !e.metaKey &&
                !e.ctrlKey &&
                e.button === 0
              ) {
                e.preventDefault();
                onSelectAgent(decodeURIComponent(agentMatch[1]));
              }
            }}
            dangerouslySetInnerHTML={{ __html: data.html }}
          />
        ) : (
          <pre style={styles.rawMarkdown}>{data.markdown}</pre>
        )
      ) : (
        <div style={styles.loading}>
          Loading real-time surveillance dashboard...
        </div>
      )}
    </div>
  );
}
