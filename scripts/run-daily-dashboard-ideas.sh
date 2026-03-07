#!/usr/bin/env bash
set -euo pipefail

export TZ="America/Sao_Paulo"
export NODE_ENV=production

audit_dir="/Users/magnuseng/.openclaw/workspace-main/logs"
mkdir -p "$audit_dir"

cd /Users/magnuseng/Projects/mission-control
/opt/homebrew/bin/node scripts/daily-dashboard-ideas.mjs >>"$audit_dir/daily-dashboard-ideas.log" 2>&1
