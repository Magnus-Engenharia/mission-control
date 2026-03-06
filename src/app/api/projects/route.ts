import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne, run } from '@/lib/db';
import type { Project } from '@/lib/types';

export const dynamic = 'force-dynamic';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// GET /api/projects?workspace_id=...
export async function GET(request: NextRequest) {
  try {
    const workspaceId = request.nextUrl.searchParams.get('workspace_id');

    let sql = 'SELECT * FROM projects';
    const params: unknown[] = [];

    if (workspaceId) {
      sql += ' WHERE workspace_id = ?';
      params.push(workspaceId);
    }

    sql += ' ORDER BY created_at DESC';

    const projects = queryAll<Project>(sql, params).map((p) => ({
      ...p,
      is_active: !!p.is_active,
    }));

    return NextResponse.json(projects);
  } catch (error) {
    console.error('Failed to list projects:', error);
    return NextResponse.json({ error: 'Failed to list projects' }, { status: 500 });
  }
}

// POST /api/projects
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      workspace_id?: string;
      name?: string;
      slug?: string;
      repo_path?: string;
      platform?: string;
      template?: string;
      is_active?: boolean;
    };

    const workspaceId = body.workspace_id || 'default';
    const name = (body.name || '').trim();
    const repoPath = (body.repo_path || '').trim();

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    if (!repoPath) {
      return NextResponse.json({ error: 'repo_path is required' }, { status: 400 });
    }

    const slug = slugify(body.slug?.trim() || name);
    if (!slug) {
      return NextResponse.json({ error: 'slug is invalid' }, { status: 400 });
    }

    const existing = queryOne<Project>(
      'SELECT * FROM projects WHERE workspace_id = ? AND slug = ?',
      [workspaceId, slug]
    );

    if (existing) {
      return NextResponse.json({ error: 'project slug already exists in workspace' }, { status: 409 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    run(
      `INSERT INTO projects (id, workspace_id, name, slug, repo_path, platform, template, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        name,
        slug,
        repoPath,
        body.platform || null,
        body.template || null,
        body.is_active === false ? 0 : 1,
        now,
        now,
      ]
    );

    const project = queryOne<Project>('SELECT * FROM projects WHERE id = ?', [id]);
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    console.error('Failed to create project:', error);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
