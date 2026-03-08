#!/usr/bin/env bash
set -euo pipefail

DB="/Users/magnuseng/Projects/mission-control/mission-control.db"
API="http://127.0.0.1:4000"

while IFS="|" read -r BUILDER_ID WS_ID; do
  [ -z "$BUILDER_ID" ] && continue

  ACTIVE_COUNT=$(sqlite3 "$DB" "SELECT COUNT(1) FROM tasks WHERE assigned_agent_id='${BUILDER_ID}' AND status IN ('in_progress','testing','review','verification');")
  if [ "$ACTIVE_COUNT" != "0" ]; then
    continue
  fi

  NEXT_TASK=$(sqlite3 "$DB" "SELECT id FROM tasks WHERE assigned_agent_id='${BUILDER_ID}' AND status='assigned' ORDER BY created_at ASC LIMIT 1;")
  if [ -n "$NEXT_TASK" ]; then
    curl -s -X POST "$API/api/tasks/$NEXT_TASK/dispatch" >/dev/null || true
    sqlite3 "$DB" "INSERT INTO task_activities (id, task_id, activity_type, message, created_at) VALUES ('$(uuidgen | tr '[:upper:]' '[:lower:]')', '$NEXT_TASK', 'status_changed', 'autopick: dispatched next queued builder task', datetime('now'));" || true
  fi
done < <(sqlite3 "$DB" "SELECT id || '|' || workspace_id FROM agents WHERE role='builder' AND status!='offline';")
