#!/usr/bin/env bash
# ==============================================================================
# SportsDesk Operations - Automated Audited Reporting Pipeline (run_reports.sh)
#
# Generates 7 standardized, auditable risk & hold surveillance reports:
#   1. Intra-day sniper surveillance: top winners last 24h
#   2. Weekend house-hold generators: top losers last 48h
#   3. NFL straight point-spread winners over 7-day settlement week
#   4. NBA total/over-under winners last 7 days
#   5. Dual-sided P&L leaderboard for the month
#   6. Sub-agent branch rollup: top losing agent downlines over 7d
#   7. All-time biggest lifetime losers / highest gross hold
#
# Usage:
#   ./run_reports.sh [--format table|json|csv] [--dir custom/path] [--sync-r2] [--help]
# ==============================================================================

set -euo pipefail

FORMAT="table"
EXT="txt"
REPORT_DIR=""
TZ_SETTING="America/New_York"
SYNC_R2=false

# Parse Command-Line Options
while [[ $# -gt 0 ]]; do
  case "$1" in
    --format|-f)
      FORMAT="$2"
      shift 2
      ;;
    --dir|-d)
      REPORT_DIR="$2"
      shift 2
      ;;
    --tz)
      TZ_SETTING="$2"
      shift 2
      ;;
    --sync-r2)
      SYNC_R2=true
      shift
      ;;
    --help|-h)
      echo "SportsDesk Operations Reporting Pipeline"
      echo "Usage: ./run_reports.sh [options]"
      echo ""
      echo "Options:"
      echo "  --format, -f <table|json|csv>  Output format (default: table)"
      echo "  --dir, -d <path>               Target reports directory (default: reports/<timestamp>)"
      echo "  --tz <timezone>                Timezone label (default: America/New_York)"
      echo "  --sync-r2                      Sync generated reports to Cloudflare R2 bucket"
      echo "  --help, -h                     Show this help guide"
      exit 0
      ;;
    *)
      echo "[Error] Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$FORMAT" == "json" ]]; then
  EXT="json"
elif [[ "$FORMAT" == "csv" ]]; then
  EXT="csv"
else
  EXT="txt"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Validate CLI Prerequisites
if ! command -v bun &>/dev/null; then
  echo "[Error] 'bun' runtime is required but not found in PATH." >&2
  exit 1
fi

if [[ ! -f "sportsdesk_cli.ts" ]]; then
  echo "[Error] 'sportsdesk_cli.ts' not found in $SCRIPT_DIR." >&2
  exit 1
fi

# Establish Timestamped Output Directory
if [[ -z "$REPORT_DIR" ]]; then
  TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  REPORT_DIR="reports/${TIMESTAMP}"
fi

mkdir -p "$REPORT_DIR"
echo "================================================================================"
echo "SPORTSDESK AUTOMATED AUDITED REPORTING PIPELINE"
echo "Target Directory : $REPORT_DIR"
echo "Output Format    : $FORMAT (extension: .$EXT)"
echo "Timezone Setting : $TZ_SETTING"
echo "Cloudflare R2    : $SYNC_R2"
echo "Timestamp (UTC)  : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "================================================================================"

# ------------------------------------------------------------------------------
# 1. Intra-day sniper surveillance: top winners last 24h
# ------------------------------------------------------------------------------
echo ""
echo "[1/7] Generating Intra-Day Sniper Surveillance (Top Winners last 24h)..."
bun run sportsdesk_cli.ts winners \
  -p 24h \
  --limit 25 \
  --sort-by net \
  --format "$FORMAT" \
  --tz "$TZ_SETTING" \
  --min-bets 3 \
  --exclude-void \
  | tee "$REPORT_DIR/01_winners_24h.${EXT}"

# ------------------------------------------------------------------------------
# 2. Weekend house-hold generators: top losers last 48h
# ------------------------------------------------------------------------------
echo ""
echo "[2/7] Generating Weekend House-Hold Generators (Top Losers last 48h)..."
bun run sportsdesk_cli.ts losers \
  -p 48h \
  --limit 25 \
  --sort-by net \
  --format "$FORMAT" \
  --tz "$TZ_SETTING" \
  --min-bets 3 \
  --exclude-void \
  | tee "$REPORT_DIR/02_losers_48h.${EXT}"

# ------------------------------------------------------------------------------
# 3. NFL straight point-spread winners over 7-day settlement week
# ------------------------------------------------------------------------------
echo ""
echo "[3/7] Generating NFL Straight Point-Spread Winners (7-day week)..."
bun run sportsdesk_cli.ts winners \
  -p 7d \
  --league NFL \
  -m spread \
  --limit 25 \
  --sort-by net \
  --format "$FORMAT" \
  --min-bets 5 \
  --exclude-void \
  | tee "$REPORT_DIR/03_nfl_spread_winners_7d.${EXT}"

# ------------------------------------------------------------------------------
# 4. NBA total/over-under winners last 7 days
# ------------------------------------------------------------------------------
echo ""
echo "[4/7] Generating NBA Total / Over-Under Winners (Last 7 days)..."
bun run sportsdesk_cli.ts winners \
  -p 7d \
  --league NBA \
  -m total \
  --limit 25 \
  --sort-by net \
  --format "$FORMAT" \
  --min-bets 5 \
  --exclude-void \
  | tee "$REPORT_DIR/04_nba_total_winners_7d.${EXT}"

# ------------------------------------------------------------------------------
# 5. Dual-sided P&L leaderboard for the month
# ------------------------------------------------------------------------------
echo ""
echo "[5/7] Generating Dual-Sided Monthly Leaderboard (30-day window)..."
bun run sportsdesk_cli.ts leaderboard \
  -p month \
  --limit 15 \
  --format "$FORMAT" \
  --tz "$TZ_SETTING" \
  | tee "$REPORT_DIR/05_monthly_leaderboard.${EXT}"

# ------------------------------------------------------------------------------
# 6. Sub-agent branch rollup: top losing agent downlines over 7d
# ------------------------------------------------------------------------------
echo ""
echo "[6/7] Generating Sub-Agent Branch Rollup (Top Losing Downlines last 7d)..."
bun run sportsdesk_cli.ts losers \
  -p 7d \
  --by-agent \
  --agent-depth 2 \
  --limit 15 \
  --sort-by net \
  --format "$FORMAT" \
  --min-bets 5 \
  | tee "$REPORT_DIR/06_agent_downline_losers_7d.${EXT}"

# ------------------------------------------------------------------------------
# 7. All-time biggest lifetime losers / highest gross hold
# ------------------------------------------------------------------------------
echo ""
echo "[7/7] Generating All-Time Biggest Lifetime Losers / Highest Gross Hold..."
bun run sportsdesk_cli.ts losers \
  -p lifetime \
  --limit 50 \
  --sort-by gross_hold \
  --format "$FORMAT" \
  --min-bets 10 \
  --exclude-void \
  | tee "$REPORT_DIR/07_lifetime_losers.${EXT}"

# ------------------------------------------------------------------------------
# Generate Audit Manifest
# ------------------------------------------------------------------------------
cat <<EOF > "$REPORT_DIR/MANIFEST.md"
# SportsDesk Audited Surveillance Report Bundle
- Generated At: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Report Format: $FORMAT
- Timezone Context: $TZ_SETTING
- Target Directory: $REPORT_DIR
- Public Gateway: https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/$REPORT_DIR

## Audited Deliverables
1. \`01_winners_24h.${EXT}\`: Intra-day sniper surveillance (top winners last 24h, min-bets=3, exclude-void)
2. \`02_losers_48h.${EXT}\`: Weekend house-hold generators (top losers last 48h, min-bets=3, exclude-void)
3. \`03_nfl_spread_winners_7d.${EXT}\`: NFL straight point-spread winners (7d settlement week, min-bets=5, exclude-void)
4. \`04_nba_total_winners_7d.${EXT}\`: NBA total/over-under winners (last 7d, min-bets=5, exclude-void)
5. \`05_monthly_leaderboard.${EXT}\`: Dual-sided P&L leaderboard for the month (limit=15)
6. \`06_agent_downline_losers_7d.${EXT}\`: Sub-agent branch rollup (top losing agent downlines over 7d, depth=2, min-bets=5)
7. \`07_lifetime_losers.${EXT}\`: All-time biggest lifetime losers / highest gross hold (limit=50, sort-by=gross_hold, min-bets=10, exclude-void)
EOF

echo ""
echo "================================================================================"
echo "REPORT BUNDLE GENERATION COMPLETE"
echo "Manifest: $REPORT_DIR/MANIFEST.md"
echo "================================================================================"
ls -lh "$REPORT_DIR"

# ------------------------------------------------------------------------------
# Optional Cloudflare R2 Sync
# ------------------------------------------------------------------------------
if [ "$SYNC_R2" = true ]; then
  echo ""
  echo "Streaming reports to Cloudflare R2 (bucket: sportsdesk-ops-reports)..."
  if [[ -f "sportsdesk_r2_sync.ts" ]]; then
    bun run sportsdesk_r2_sync.ts "$REPORT_DIR"
  else
    echo "[Notice] sportsdesk_r2_sync.ts not found. Skipping R2 sync."
  fi
fi
