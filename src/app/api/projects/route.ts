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
  const v = value.trim();
  if (/^git@github\.com:[^/]+\/[^/]+(\.git)?$/i.test(v)) return true;
  try {
    const url = new URL(v);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.toLowerCase().includes('github.com');
  } catch {
    return false;
  }
}

function normalizeGitHubTemplateUrl(value: string): string {
  const v = value.trim();

  // Already SSH
  const sshMatch = v.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `git@github.com:${sshMatch[1]}/${sshMatch[2]}.git`;
  }

  // HTTPS forms: /owner/repo, /owner/repo.git, /owner/repo/tree/main
  try {
    const url = new URL(v);
    const isGitHub = url.hostname.toLowerCase() === 'github.com' || url.hostname.toLowerCase() === 'www.github.com';
    if (!isGitHub) return v;

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/i, '');
      return `git@github.com:${owner}/${repo}.git`;
    }
  } catch {
    // fallthrough
  }

  return v;
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


function ensureCriticalDocs(repoPath: string, projectName: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  const docPath = path.join(repoPath, 'PROJECT_CRITICALS.md');
  if (!fs.existsSync(docPath)) {
    const content = `# ${projectName} — Project Criticals

## Features Implementadas
-

## Contratos
-

## Decisões Técnicas
-

## Ambientes e Comandos
-

## Riscos / Pendências
-
`;
    fs.writeFileSync(docPath, content, 'utf8');
  }
}

function bootstrapProjectRepos(repoPath: string, templates: { dir: string; url: string }[]) {
  fs.mkdirSync(repoPath, { recursive: true });
  for (const { dir, url } of templates) {
    if (!url) continue;
    if (!isValidTemplateUrl(url)) {
      throw new Error(`Invalid template URL for ${dir}. Use GitHub SSH or HTTPS URL.`);
    }
    const normalizedUrl = normalizeGitHubTemplateUrl(url);
    const target = path.join(repoPath, dir);
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      throw new Error(`Target folder already exists and is not empty: ${target}`);
    }
    scaffoldFromTemplate(normalizedUrl, target);
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
      include_frontend?: boolean;
      include_backend?: boolean;
      include_mobile?: boolean;
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

    const includeFrontend = body.include_frontend !== false;
    const includeBackend = body.include_backend !== false;
    const includeMobile = body.include_mobile !== false;

    const frontendTemplate = body.template_frontend_repo ? normalizeGitHubTemplateUrl(body.template_frontend_repo) : 'git@github.com:Magnus-Engenharia/VueTemplate.git';
    const backendTemplate = body.template_backend_repo ? normalizeGitHubTemplateUrl(body.template_backend_repo) : 'git@github.com:Magnus-Engenharia/RailsTemplate.git';
    const iosTemplateRaw = body.template_ios_repo || body.template_app_repo;
    const iosTemplate = iosTemplateRaw ? normalizeGitHubTemplateUrl(iosTemplateRaw) : 'git@github.com:Magnus-Engenharia/AppTemplate.git';
    const androidTemplateRaw = body.template_android_repo || body.template_extra_repo;
    const androidTemplate = androidTemplateRaw ? normalizeGitHubTemplateUrl(androidTemplateRaw) : null;


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
        frontendTemplate,
        backendTemplate,
        iosTemplate,
        androidTemplate,
        body.is_active === false ? 0 : 1,
        now,
        now,
      ]
    );

    const shouldBootstrap = body.bootstrap_from_templates !== false;
    if (shouldBootstrap) {
      try {
        const stackTemplates: Array<{ dir: string; url: string }> = [];
        if (includeFrontend) stackTemplates.push({ dir: 'apps/web', url: frontendTemplate });
        if (includeBackend) stackTemplates.push({ dir: 'apps/api', url: backendTemplate });
        if (includeMobile) stackTemplates.push({ dir: 'apps/mobile', url: iosTemplate });

        if (stackTemplates.length === 0) {
          throw new Error('Select at least one stack (web/backend/mobile).');
        }

        bootstrapProjectRepos(repoPath, stackTemplates);
        ensureCriticalDocs(repoPath, name);
        const used = [
          includeFrontend ? 'Vue (web)' : null,
          includeBackend ? 'Rails (backend)' : null,
          includeMobile ? 'Swift (mobile)' : null,
        ].filter(Boolean).join(', ');
        const directive = `## Stacks Ativadas
- ${used}`;
        const criticalPath = path.join(repoPath, 'PROJECT_CRITICALS.md');
        if (fs.existsSync(criticalPath) && fs.readFileSync(criticalPath, 'utf8').indexOf('## Stacks Ativadas') === -1) {
          fs.appendFileSync(criticalPath, `
${directive}
`);
        }
      } catch (bootstrapError) {
        run('DELETE FROM projects WHERE id = ?', [id]);
        const message = bootstrapError instanceof Error ? bootstrapError.message : 'Failed to bootstrap repositories';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    } else {
      ensureCriticalDocs(repoPath, name);
    }

    const project = queryOne<Project>('SELECT * FROM projects WHERE id = ?', [id]);
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    console.error('Failed to create project:', error);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
