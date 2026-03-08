#!/usr/bin/env bash
set -euo pipefail

export TZ="America/Sao_Paulo"
export NODE_ENV=production
export MISSION_CONTROL_API_BASE="http://127.0.0.1:4000"
export BUILDER_STALL_MINUTES="12"
export BUILDER_ESCALATE_MINUTES="20"

log_dir="/Users/magnuseng/.openclaw/workspace-main/logs"
mkdir -p "$log_dir"

cd /Users/magnuseng/Projects/mission-control
/opt/homebrew/bin/node scripts/watchdog-builder-stalls.mjs >>"$log_dir/builder-watchdog.log" 2>&1
