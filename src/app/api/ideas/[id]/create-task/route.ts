import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import type { Idea, Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams { params: Promise<{ id: string }> }

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const idea = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
    if (!idea) return NextResponse.json({ error: 'Idea not found' }, { status: 404 });

    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    const description = [idea.summary || '', idea.source ? `\nSource: ${idea.source}` : ''].join('').trim();

    run(
      `INSERT INTO tasks (id, title, description, status, priority, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, 'inbox', 'normal', ?, ?, ?)`,
      [taskId, idea.title, description || null, idea.workspace_id, now, now]
    );

    run(`UPDATE ideas SET status = 'accepted', updated_at = ? WHERE id = ?`, [now, id]);

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    console.error('Failed to create task from idea:', error);
    return NextResponse.json({ error: 'Failed to create task from idea' }, { status: 500 });
  }
}
