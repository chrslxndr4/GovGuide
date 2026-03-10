#!/bin/bash
#
# Sequential FEC data imports, one per day.
# FEC API limit: ~1,000 requests/hour.
# Each import can take hours, so we run one per cycle.
#
# Cycle:
#   Day 0: committees  (879 pages, ~1hr at 4s/page)
#   Day 1: expenditures (16,633 pages, ~18hrs at 4s/page)
#   Day 2: (rest day — expenditures may still be running)
#
# The contributions import (2.6M pages) is excluded — too large for API.
# Use FEC bulk data files instead: https://www.fec.gov/data/browse-data/?tab=bulk-data
#
# Usage:
#   ./scripts/cron-fec-imports.sh           # Run next import
#   ./scripts/cron-fec-imports.sh reset     # Reset to step 0
#   ./scripts/cron-fec-imports.sh status    # Show progress

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_FILE="$PROJECT_DIR/.fec-import-step"
LOCK_FILE="$PROJECT_DIR/.fec-import.lock"

STEPS=("committees" "expenditures")
TOTAL_STEPS=${#STEPS[@]}

case "${1:-run}" in
  reset)
    echo "0" > "$STATE_FILE"
    rm -f "$LOCK_FILE"
    echo "Reset to step 0 (committees)."
    exit 0
    ;;
  status)
    CURRENT=$(cat "$STATE_FILE" 2>/dev/null || echo "0")
    echo "Current step: $CURRENT / $TOTAL_STEPS"
    if [ "$CURRENT" -ge "$TOTAL_STEPS" ]; then
      echo "All FEC imports complete! Run 'reset' to start over."
    else
      echo "Next: ${STEPS[$CURRENT]}"
    fi
    if [ -f "$LOCK_FILE" ]; then
      echo "LOCKED — an import is currently running (PID: $(cat "$LOCK_FILE"))"
    fi
    exit 0
    ;;
  run) ;;
  *) echo "Usage: $0 [run|reset|status]"; exit 1 ;;
esac

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
  PID=$(cat "$LOCK_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Another FEC import is running (PID: $PID). Skipping."
    exit 0
  else
    echo "Stale lock file found (PID: $PID no longer running). Cleaning up."
    rm -f "$LOCK_FILE"
  fi
fi

STEP=$(cat "$STATE_FILE" 2>/dev/null || echo "0")

if [ "$STEP" -ge "$TOTAL_STEPS" ]; then
  echo "All FEC imports complete. Run '$0 reset' to start a new cycle."
  exit 0
fi

IMPORT="${STEPS[$STEP]}"
echo "=== FEC Import Step $((STEP + 1))/$TOTAL_STEPS: $IMPORT ==="
echo ""

cd "$PROJECT_DIR"
set -a; source .env; set +a

# Write lock
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

case "$IMPORT" in
  committees)
    npx tsx scripts/import-fec-committees.ts
    ;;
  expenditures)
    npx tsx scripts/import-fec-expenditures.ts
    ;;
esac

# Advance
echo "$((STEP + 1))" > "$STATE_FILE"
echo ""
echo "Step $((STEP + 1))/$TOTAL_STEPS complete."
