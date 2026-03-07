#!/usr/bin/env bash
set -euo pipefail

DB_PATH="/Users/magnuseng/Projects/mission-control/mission-control.db"
BACKUP_PATH="/Users/magnuseng/Projects/mission-control/mission-control.db.pre-cleanup-$(date +%Y%m%d-%H%M%S).backup"

# Kill dev server using port 4000 if running
lsof -tiTCP:4000 -sTCP:LISTEN | xargs -r kill -9 || true

# Backup database
cp "$DB_PATH" "$BACKUP_PATH"

# Extract project paths currently in DB and delete those dirs
sqlite3 "$DB_PATH" "select repo_path from projects where repo_path is not null and repo_path != ''" > /tmp/mc_project_paths.txt
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if [ -d "$p" ]; then
    rm -rf "$p"
  fi
done < /tmp/mc_project_paths.txt

# Fresh reset
cd /Users/magnuseng/Projects/mission-control
npm run db:reset

echo "Mission Control dashboard data cleaned. Backup: $BACKUP_PATH"
