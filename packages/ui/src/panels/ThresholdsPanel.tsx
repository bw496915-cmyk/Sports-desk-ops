import type React from "react";
import {
  DASHBOARD_LEAGUES,
  DASHBOARD_META,
  DASHBOARD_THRESHOLDS,
} from "../config/dashboard.ts";
import { styles } from "../dashboard_styles.ts";

/**
 * Renders the dispatch thresholds inlined from `config/dashboard.toml`.
 *
 * This read is what keeps the dashboard's tree-shake probe honest: the
 * `sharp` key is only present in the bundle because this component renders it.
 * If this panel is removed or stops reading a key, update REQUIRED_PROBE in
 * scripts/validate_dashboard_config.ts in the same change.
 */
export function ThresholdsPanel(): React.ReactElement {
  return (
    <div style={styles.dnsBar}>
      <span style={styles.dnsLabel}>⚙ Dispatch thresholds:</span>
      <span>
        Sharp: <b>{DASHBOARD_THRESHOLDS.sharp}</b>
      </span>
      <span>
        Steam: <b>{DASHBOARD_THRESHOLDS.steam}</b>
      </span>
      <span>
        Leagues: <b>{DASHBOARD_LEAGUES.names.join(", ")}</b>
      </span>
      <span style={styles.dnsLabel}>config {DASHBOARD_META.generated_at}</span>
    </div>
  );
}
