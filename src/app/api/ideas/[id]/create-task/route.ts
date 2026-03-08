import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryOne, run } from '@/lib/db';
import type { Idea, Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams {
  params: Promise<{ id: string }>;
}

const slugify = (input: string) =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const idea = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
    if (!idea) return NextResponse.json({ error: 'Idea not found' }, { status: 404 });

    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    const description = [idea.summary || '', idea.source ? `\nSource: ${idea.source}` : ''].join('').trim();

    let phaseTag: 'mvp' | 'growth' | 'stabilizing' = 'mvp';
    try {
      const tags: string[] = JSON.parse(idea.tags_json || '[]');
      if (tags.includes('phase:growth')) phaseTag = 'growth';
      if (tags.includes('phase:stabilizing')) phaseTag = 'stabilizing';
      if (tags.includes('phase:mvp')) phaseTag = 'mvp';
    } catch {
      // keep default
    }

    const priorityByPhase: Record<typeof phaseTag, 'high' | 'normal'> = {
      mvp: 'high',
      growth: 'normal',
      stabilizing: 'high',
    };

    let targetWorkspaceId = idea.workspace_id;
    let projectId: string | null = (idea as Idea).project_id || null;

    if (!projectId && !((idea as Idea).is_new_project)) {
      const existingProject = db
        .prepare('SELECT id FROM projects WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1')
        .get(idea.workspace_id) as { id: string } | undefined;
      projectId = existingProject?.id || null;
    }

    if (!projectId && (idea as Idea).is_new_project) {
      const rawName = (idea.title || 'new-project').trim() || 'new-project';
      const dashboardSlug = slugify(rawName) || 'new-dashboard';
      let suffix = 1;
      let finalSlug = dashboardSlug;

      while (db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(finalSlug)) {
        finalSlug = `${dashboardSlug}-${suffix++}`;
      }

      const workspaceId = crypto.randomUUID();
      db.prepare(
        'INSERT INTO workspaces (id, name, slug, icon, description, default_phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(workspaceId, rawName, finalSlug, '💡', 'Created from idea', phaseTag, now, now);

      const projectIdGenerated = crypto.randomUUID();
      const projectSlug = slugify(rawName) || finalSlug;
      const projectPath = `/Users/magnuseng/Projects/${projectSlug}`;
      run(
        `INSERT INTO projects (id, workspace_id, name, slug, repo_path, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [projectIdGenerated, workspaceId, rawName, projectSlug, projectPath, now, now]
      );

      targetWorkspaceId = workspaceId;
      projectId = projectIdGenerated;
    }

    run(
      `INSERT INTO tasks (id, title, description, status, priority, workspace_id, project_id, created_at, updated_at)
       VALUES (?, ?, ?, 'planning', ?, ?, ?, ?, ?)`,
      [taskId, idea.title, description || null, priorityByPhase[phaseTag], targetWorkspaceId, projectId, now, now]
    );

    run('DELETE FROM ideas WHERE id = ?', [id]);

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    console.error('Failed to create task from idea:', error);
    return NextResponse.json({ error: 'Failed to create task from idea' }, { status: 500 });
  }
}
