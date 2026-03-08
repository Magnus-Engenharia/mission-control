import { NextRequest, NextResponse } from 'next/server';
import { queryOne, queryAll, run } from '@/lib/db';
import { populateTaskRolesFromAgents } from '@/lib/workflow-engine';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const objective = queryOne<{
      id: string;
      workspace_id: string;
      project_id: string;
      title: string;
      draft_tasks_json?: string | null;
      status: string;
    }>('SELECT * FROM objectives WHERE id = ?', [id]);

    if (!objective) return NextResponse.json({ error: 'Objective not found' }, { status: 404 });
    if (!objective.draft_tasks_json) return NextResponse.json({ error: 'No draft tasks to approve' }, { status: 400 });

    const draftTasks = JSON.parse(objective.draft_tasks_json) as Array<{
      title: string;
      summary?: string;
      acceptance_criteria?: string[];
      priority?: 'low' | 'normal' | 'high';
      target_surfaces?: Array<'web' | 'api' | 'mobile'>;
    }>;

    if (!Array.isArray(draftTasks) || draftTasks.length === 0) {
      return NextResponse.json({ error: 'Empty task draft list' }, { status: 400 });
    }

    let created = 0;
    for (const dt of draftTasks) {
      const title = String(dt.title || '').trim();
      if (!title) continue;
      const taskId = crypto.randomUUID();
      const description = `${dt.summary || ''}${Array.isArray(dt.acceptance_criteria) && dt.acceptance_criteria.length ? `\n\nAcceptance Criteria:\n- ${dt.acceptance_criteria.join('\n- ')}` : ''}`.trim() || null;
      const target = Array.isArray(dt.target_surfaces) && dt.target_surfaces.length === 1 ? dt.target_surfaces[0] : 'fullstack';
      const priority = dt.priority === 'high' || dt.priority === 'low' ? dt.priority : 'normal';

      run(
        `INSERT INTO tasks (id, title, description, status, priority, target, workspace_id, project_id, created_at, updated_at)
         VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [taskId, title, description, priority, target, objective.workspace_id, objective.project_id]
      );

      // Force strict default workflow template
      const strict = queryOne<{ id: string }>(
        `SELECT id FROM workflow_templates WHERE workspace_id = ? AND name = 'Strict' LIMIT 1`,
        [objective.workspace_id]
      );
      if (strict?.id) {
        run('UPDATE tasks SET workflow_template_id = ? WHERE id = ?', [strict.id, taskId]);
      }

      populateTaskRolesFromAgents(taskId, objective.workspace_id);
      created += 1;
    }

    run(
      `UPDATE objectives SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [id]
    );

    const createdTasks = queryAll('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 50', [objective.project_id]);

    return NextResponse.json({ success: true, created_count: created, tasks: createdTasks });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to approve objective: ' + (error as Error).message }, { status: 500 });
  }
}
