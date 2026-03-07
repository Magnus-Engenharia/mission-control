import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { queryAll, queryOne, run } from '@/lib/db';
import type { Project } from '@/lib/types';

export const dynamic = 'force-dynamic';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function isValidTemplateUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.includes('github.com');
  } catch {
    return false;
  }
}

function scaffoldFromTemplate(templateUrl: string, targetDir: string) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-template-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', templateUrl, tmpRoot], { stdio: 'ignore' });
    fs.rmSync(path.join(tmpRoot, '.git'), { force: true, recursive: true });

    fs.mkdirSync(targetDir, { recursive: true });
    const entries = fs.readdirSync(tmpRoot);
    for (const entry of entries) {
      const src = path.join(tmpRoot, entry);
      const dst = path.join(targetDir, entry);
      fs.cpSync(src, dst, { recursive: true, force: true });
    }

    // Initialize as an independent repo (no relation to template repo)
    execFileSync('git', ['init', '-b', 'main'], { cwd: targetDir, stdio: 'ignore' });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function bootstrapProjectRepos(repoPath: string, templates: { dir: string; url: string }[]) {
  fs.mkdirSync(repoPath, { recursive: true });
  for (const { dir, url } of templates) {
    if (!url) continue;
    if (!isValidTemplateUrl(url)) {
      throw new Error(`Invalid template URL for ${dir}. Use full https://github.com/... URL`);
    }
    const target = path.join(repoPath, dir);
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      throw new Error(`Target folder already exists and is not empty: ${target}`);
    }
    scaffoldFromTemplate(url, target);
  }
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
      template_frontend_repo?: string;
      template_backend_repo?: string;
      template_ios_repo?: string;
      template_android_repo?: string;
      // Backward compatibility
      template_app_repo?: string;
      template_extra_repo?: string;
      bootstrap_from_templates?: boolean;
      is_active?: boolean;
    };

    const workspaceId = body.workspace_id || 'default';
    const name = (body.name || '').trim();

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const slug = slugify(body.slug?.trim() || name);
    if (!slug) {
      return NextResponse.json({ error: 'slug is invalid' }, { status: 400 });
    }

    const repoPath = (body.repo_path || '').trim() || `/Users/magnuseng/Projects/${slug}`;

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
      `INSERT INTO projects (
        id, workspace_id, name, slug, repo_path, platform, template,
        template_frontend_repo, template_backend_repo, template_app_repo, template_extra_repo,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        name,
        slug,
        repoPath,
        body.platform || null,
        body.template || null,
        body.template_frontend_repo || null,
        body.template_backend_repo || null,
        (body.template_ios_repo || body.template_app_repo) || null,
        (body.template_android_repo || body.template_extra_repo) || null,
        body.is_active === false ? 0 : 1,
        now,
        now,
      ]
    );

    const shouldBootstrap = body.bootstrap_from_templates !== false;
    if (shouldBootstrap) {
      try {
        bootstrapProjectRepos(repoPath, [
          { dir: 'frontend', url: body.template_frontend_repo || '' },
          { dir: 'backend', url: body.template_backend_repo || '' },
          { dir: 'ios', url: body.template_ios_repo || body.template_app_repo || '' },
          { dir: 'android', url: body.template_android_repo || body.template_extra_repo || '' },
        ]);
      } catch (bootstrapError) {
        run('DELETE FROM projects WHERE id = ?', [id]);
        const message = bootstrapError instanceof Error ? bootstrapError.message : 'Failed to bootstrap repositories';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    const project = queryOne<Project>('SELECT * FROM projects WHERE id = ?', [id]);
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    console.error('Failed to create project:', error);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
