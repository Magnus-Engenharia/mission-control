import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import type { Project, Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// PATCH /api/tasks/[id]/project
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: taskId } = await params;
    const body = await request.json() as { project_id?: string | null };

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (body.project_id) {
      const project = queryOne<Project>('SELECT * FROM projects WHERE id = ?', [body.project_id]);
      if (!project) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      if (project.workspace_id !== task.workspace_id) {
        return NextResponse.json({ error: 'Project and task must belong to same workspace' }, { status: 400 });
      }
    }

    run(
      'UPDATE tasks SET project_id = ?, updated_at = ? WHERE id = ?',
      [body.project_id || null, new Date().toISOString(), taskId]
    );

    const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update task project:', error);
    return NextResponse.json({ error: 'Failed to update task project' }, { status: 500 });
  }
}
