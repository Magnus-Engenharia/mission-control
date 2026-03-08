#!/usr/bin/env node
import Database from 'better-sqlite3';

const DB_PATH = '/Users/magnuseng/Projects/mission-control/mission-control.db';
const API_BASE = process.env.MISSION_CONTROL_API_BASE || 'http://127.0.0.1:4000';
const STALL_MINUTES = Number(process.env.BUILDER_STALL_MINUTES || 12);
const ESCALATE_MINUTES = Number(process.env.BUILDER_ESCALATE_MINUTES || 20);

function minutesSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(String(iso)).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function logActivity(db, taskId, agentId, message) {
  db.prepare(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, 'status_changed', ?, datetime('now'))`
  ).run(crypto.randomUUID(), taskId, agentId || null, message);
}

async function dispatchTask(taskId) {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}/dispatch`, { method: 'POST' });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function main() {
  const db = new Database(DB_PATH, { readonly: false });

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.assigned_agent_id, t.updated_at,
           a.id as agent_id, a.role
    FROM tasks t
    JOIN agents a ON a.id = t.assigned_agent_id
    WHERE t.status = 'in_progress' AND a.role = 'builder'
  `).all();

  let nudged = 0;
  let escalated = 0;

  for (const task of tasks) {
    const lastActivity = db.prepare(
      `SELECT created_at FROM task_activities WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(task.id);
    const lastDeliverable = db.prepare(
      `SELECT created_at FROM task_deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(task.id);

    const idleMin = Math.min(
      minutesSince(task.updated_at),
      minutesSince(lastActivity?.created_at),
      minutesSince(lastDeliverable?.created_at)
    );

    if (idleMin < STALL_MINUTES) continue;

    const lastNudge = db.prepare(
      `SELECT created_at FROM task_activities
       WHERE task_id = ? AND message LIKE 'watchdog:nudged%'
       ORDER BY created_at DESC LIMIT 1`
    ).get(task.id);

    const minutesFromNudge = minutesSince(lastNudge?.created_at);

    if (!lastNudge) {
      const result = await dispatchTask(task.id);
      logActivity(db, task.id, task.agent_id, `watchdog:nudged — builder stalled ${Math.round(idleMin)}m, dispatch retried (${result.status})`);
      nudged += 1;
      continue;
    }

    if (minutesFromNudge >= (ESCALATE_MINUTES - STALL_MINUTES)) {
      db.prepare(
        `UPDATE tasks
         SET status = 'assigned',
             planning_dispatch_error = ?,
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(`Watchdog escalation: builder stalled for ${Math.round(idleMin)}m in progress. Auto-queued for re-dispatch.`, task.id);

      const result = await dispatchTask(task.id);
      logActivity(db, task.id, task.agent_id, `watchdog:escalated — moved to assigned after stall, dispatch retried (${result.status})`);
      escalated += 1;
    }
  }

  db.close();
  console.log(`[builder-watchdog] scanned=${tasks.length} nudged=${nudged} escalated=${escalated}`);
}

main().catch((err) => {
  console.error('[builder-watchdog] fatal', err);
  process.exit(1);
});
