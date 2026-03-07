import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne, run } from '@/lib/db';
import type { Idea } from '@/lib/types';

export const dynamic = 'force-dynamic';

// GET /api/ideas?workspace_id=...
export async function GET(request: NextRequest) {
  try {
    const workspaceId = request.nextUrl.searchParams.get('workspace_id') || 'default';
    const scope = (request.nextUrl.searchParams.get('scope') || 'dashboard') as 'dashboard' | 'global';
    const ideas = scope === 'global'
      ? queryAll<Idea>('SELECT * FROM ideas WHERE workspace_id = ? AND is_new_project = 1 ORDER BY created_at DESC', [workspaceId])
      : queryAll<Idea>('SELECT * FROM ideas WHERE workspace_id = ? AND is_new_project = 0 ORDER BY created_at DESC', [workspaceId]);
    return NextResponse.json(ideas);
  } catch (error) {
    console.error('Failed to list ideas:', error);
    return NextResponse.json({ error: 'Failed to list ideas' }, { status: 500 });
  }
}

// POST /api/ideas
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<Idea> & { tags?: string[]; project_id?: string; is_new_project?: boolean };
    const workspaceId = body.workspace_id || 'default';
    const title = (body.title || '').trim();
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    run(
      `INSERT INTO ideas (id, workspace_id, title, summary, source, tags_json, project_id, is_new_project, status, score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        title,
        body.summary || null,
        body.source || null,
        body.tags_json || JSON.stringify(body.tags || []),
        body.project_id || null,
        body.is_new_project ? 1 : 0,
        body.status || 'new',
        body.score ?? null,
        now,
        now,
      ]
    );

    const created = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Failed to create idea:', error);
    return NextResponse.json({ error: 'Failed to create idea' }, { status: 500 });
  }
}
