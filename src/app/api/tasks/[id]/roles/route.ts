import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne, run, getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/[id]/roles
 * List role assignments for a task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const roles = queryAll<{
      id: string; task_id: string; role: string; agent_id: string;
      created_at: string; agent_name: string; agent_emoji: string;
    }>(
      `SELECT tr.*, a.name as agent_name, a.avatar_emoji as agent_emoji
       FROM task_roles tr
       JOIN agents a ON tr.agent_id = a.id
       WHERE tr.task_id = ?
       ORDER BY tr.created_at ASC`,
      [taskId]
    );

    return NextResponse.json(roles);
  } catch (error) {
    console.error('Failed to fetch task roles:', error);
    return NextResponse.json({ error: 'Failed to fetch roles' }, { status: 500 });
  }
}

/**
 * PUT /api/tasks/[id]/roles
 * Assign roles for a task (replaces all existing role assignments)
 * Body: { roles: [{ role: "builder", agent_id: "..." }, ...] }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json();
    const { roles } = body;

    if (!Array.isArray(roles)) {
      return NextResponse.json(
        { error: 'roles must be an array of { role, agent_id }' },
        { status: 400 }
      );
    }

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const db = getDb();
    db.transaction(() => {
      // Clear existing roles
      db.prepare('DELETE FROM task_roles WHERE task_id = ?').run(taskId);

      // Insert new roles
      const insert = db.prepare(
        `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      );

      for (const { role, agent_id } of roles) {
        if (role && agent_id) {
          insert.run(crypto.randomUUID(), taskId, role, agent_id);
        }
      }

      // Also set the primary assigned_agent_id to builder (first role fallback) if not set
      if (roles.length > 0 && !task.assigned_agent_id) {
        const primaryRole =
          roles.find((r: { role: string }) => r.role === 'builder') ||
          roles[0];
        if (primaryRole) {
          db.prepare('UPDATE tasks SET assigned_agent_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(primaryRole.agent_id, taskId);
        }
      }
    })();

    // Fetch and return updated roles
    const updatedRoles = queryAll(
      `SELECT tr.*, a.name as agent_name, a.avatar_emoji as agent_emoji
       FROM task_roles tr
       JOIN agents a ON tr.agent_id = a.id
       WHERE tr.task_id = ?
       ORDER BY tr.created_at ASC`,
      [taskId]
    );

    // Broadcast task update
    const updatedTask = queryOne<Task>(
      `SELECT t.*, aa.name as assigned_agent_name, aa.avatar_emoji as assigned_agent_emoji
       FROM tasks t LEFT JOIN agents aa ON t.assigned_agent_id = aa.id WHERE t.id = ?`,
      [taskId]
    );
    if (updatedTask) {
      broadcast({ type: 'task_updated', payload: updatedTask });
    }

    return NextResponse.json(updatedRoles);
  } catch (error) {
    console.error('Failed to update task roles:', error);
    return NextResponse.json({ error: 'Failed to update roles' }, { status: 500 });
  }
}
