#!/usr/bin/env bash
set -euo pipefail

# Stop any dev server on 4000
lsof -tiTCP:4000 -sTCP:LISTEN | xargs -r kill -9 || true

# Remove runtime/build artifacts
cd /Users/magnuseng/Projects/mission-control
[ -d .next ] && rm -rf .next
[ -d .turbo ] && rm -rf .turbo

# Remove database sidecar/journals from incomplete runs
rm -f mission-control.db-wal mission-control.db-shm mission-control.db-journal

# Optional: remove backup snapshots from previous resets (uncomment if desired)
# rm -f mission-control.db.backup mission-control.db.pre-cleanup-*.backup mission-control.db.bak.*

# Optional cleanup of local temp logs
find /tmp -maxdepth 1 \( -name 'mc_*' -o -name 'qmd-refresh.log' -o -name 'triage.log' -o -name 'daily-dashboard-ideas.log*' \) -exec rm -f {} +

# Restart fresh database seed if needed (ensure app starts clean)
if [ -f mission-control.db ] && sqlite3 mission-control.db "select 1 from sqlite_master limit 1" >/dev/null 2>&1; then
  :
else
  npm run db:seed
fi

echo "Mission Control runtime/artifacts flushed."
