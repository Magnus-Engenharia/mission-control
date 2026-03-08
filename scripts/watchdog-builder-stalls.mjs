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

async function patchTaskStatus(taskId, status) {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function main() {
  const db = new Database(DB_PATH, { readonly: false });

  const builderTasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.workspace_id, t.assigned_agent_id, t.updated_at,
           a.id as agent_id, a.role
    FROM tasks t
    JOIN agents a ON a.id = t.assigned_agent_id
    WHERE t.status = 'in_progress' AND a.role = 'builder'
  `).all();

  const learnerTasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.workspace_id, t.assigned_agent_id, t.updated_at,
           a.id as agent_id, a.role
    FROM tasks t
    JOIN agents a ON a.id = t.assigned_agent_id
    WHERE t.status = 'verification' AND a.role = 'learner'
  `).all();

  let autoTransitioned = 0;
  let nudged = 0;
  let escalated = 0;
  let learnerNudged = 0;
  let learnerBypassed = 0;

  for (const task of builderTasks) {
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

    // Builder completion handoff guard:
    // if builder logged completed + deliverable exists but status never moved,
    // auto-transition to testing/review and dispatch downstream stage.
    const lastBuilderCompleted = db.prepare(
      `SELECT created_at FROM task_activities
       WHERE task_id = ? AND activity_type = 'completed' AND (agent_id = ? OR agent_id IS NULL)
       ORDER BY created_at DESC LIMIT 1`
    ).get(task.id, task.agent_id);

    const hasDeliverable = Boolean(lastDeliverable?.created_at);
    const completedRecently = minutesSince(lastBuilderCompleted?.created_at) <= 30;

    if (hasDeliverable && completedRecently) {
      const ws = db.prepare('SELECT bypass_tester FROM workspaces WHERE id = ?').get(task.workspace_id);
      const bypassTester = Boolean(ws?.bypass_tester);
      const targetStatus = bypassTester ? 'review' : 'testing';

      const patch = await patchTaskStatus(task.id, targetStatus);
      const dispatch = await dispatchTask(task.id);
      logActivity(
        db,
        task.id,
        task.agent_id,
        `watchdog:auto-transition — builder completion evidence detected, moved to ${targetStatus} (patch ${patch.status}, dispatch ${dispatch.status})`
      );
      autoTransitioned += 1;
      continue;
    }

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

  for (const task of learnerTasks) {
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

    const lastLearnerCompleted = db.prepare(
      `SELECT created_at FROM task_activities
       WHERE task_id = ? AND activity_type = 'completed' AND (agent_id = ? OR agent_id IS NULL)
       ORDER BY created_at DESC LIMIT 1`
    ).get(task.id, task.agent_id);

    const learnerHasEvidence = Boolean(lastLearnerCompleted?.created_at) && Boolean(lastDeliverable?.created_at);
    if (learnerHasEvidence) {
      const patch = await patchTaskStatus(task.id, 'done');
      logActivity(db, task.id, task.agent_id, `watchdog:learner-auto-done — completion evidence detected (patch ${patch.status})`);
      learnerBypassed += 1;
      continue;
    }

    if (idleMin >= ESCALATE_MINUTES) {
      const patch = await patchTaskStatus(task.id, 'done');
      logActivity(db, task.id, task.agent_id, `watchdog:learner-timeout-bypass — stalled ${Math.round(idleMin)}m, moved to done (patch ${patch.status})`);
      learnerBypassed += 1;
      continue;
    }

    const result = await dispatchTask(task.id);
    logActivity(db, task.id, task.agent_id, `watchdog:learner-nudged — stalled ${Math.round(idleMin)}m, dispatch retried (${result.status})`);
    learnerNudged += 1;
  }

  db.close();
  console.log(`[builder-watchdog] scannedBuilder=${builderTasks.length} autoTransitioned=${autoTransitioned} nudged=${nudged} escalated=${escalated} scannedLearner=${learnerTasks.length} learnerNudged=${learnerNudged} learnerBypassed=${learnerBypassed}`);
}

main().catch((err) => {
  console.error('[builder-watchdog] fatal', err);
  process.exit(1);
});
