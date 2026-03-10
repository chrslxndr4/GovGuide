#!/bin/bash
#
# Batch import state officials from OpenStates API.
# OpenStates free tier: 250 requests/day.
# Each state needs ~5 requests (3-4 pages legislators + 1 governor).
# We process 8 states per run = ~40 requests, well within the limit.
#
# Schedule: Run once daily via cron. Cycles through all states over 7 days.
# Uses a state file to track which batch to run next.
#
# Usage:
#   ./scripts/cron-state-officials.sh          # Run next batch
#   ./scripts/cron-state-officials.sh reset     # Reset to batch 0
#   ./scripts/cron-state-officials.sh status    # Show progress

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_FILE="$PROJECT_DIR/.state-officials-batch"

# 7 batches of ~7-8 states each
BATCHES=(
  "AL,AK,AZ,AR,CA,CO,CT"
  "DE,FL,GA,HI,ID,IL,IN"
  "IA,KS,KY,LA,ME,MD,MA"
  "MI,MN,MS,MO,MT,NE,NV"
  "NH,NJ,NM,NY,NC,ND,OH"
  "OK,OR,PA,RI,SC,SD,TN"
  "TX,UT,VT,VA,WA,WV,WI,WY,DC"
)

TOTAL_BATCHES=${#BATCHES[@]}

# Handle commands
case "${1:-run}" in
  reset)
    echo "0" > "$STATE_FILE"
    echo "Reset to batch 0."
    exit 0
    ;;
  status)
    if [ -f "$STATE_FILE" ]; then
      CURRENT=$(cat "$STATE_FILE")
    else
      CURRENT=0
    fi
    echo "Current batch: $CURRENT / $TOTAL_BATCHES"
    if [ "$CURRENT" -ge "$TOTAL_BATCHES" ]; then
      echo "All batches complete! Run 'reset' to start over."
    else
      echo "Next batch: ${BATCHES[$CURRENT]}"
    fi
    exit 0
    ;;
  run)
    ;;
  *)
    echo "Usage: $0 [run|reset|status]"
    exit 1
    ;;
esac

# Get current batch number
if [ -f "$STATE_FILE" ]; then
  BATCH_NUM=$(cat "$STATE_FILE")
else
  BATCH_NUM=0
fi

if [ "$BATCH_NUM" -ge "$TOTAL_BATCHES" ]; then
  echo "All $TOTAL_BATCHES batches complete. Run '$0 reset' to start over."
  exit 0
fi

STATES="${BATCHES[$BATCH_NUM]}"
echo "=== State Officials Batch $((BATCH_NUM + 1))/$TOTAL_BATCHES: $STATES ==="
echo ""

cd "$PROJECT_DIR"

# Source .env
set -a
source .env
set +a

# Run the import for this batch of states
STATES="$STATES" npx tsx scripts/import-state-officials.ts 2>&1

# Advance to next batch
echo "$((BATCH_NUM + 1))" > "$STATE_FILE"
echo ""
echo "Batch $((BATCH_NUM + 1))/$TOTAL_BATCHES complete. Next run will process batch $((BATCH_NUM + 2))."
