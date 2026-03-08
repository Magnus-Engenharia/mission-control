import { NextRequest, NextResponse } from 'next/server';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';

export const dynamic = 'force-dynamic';

const DEFAULT_SESSION_KEY_PREFIX = 'agent:main:';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const objectives = queryAll(
    `SELECT * FROM objectives WHERE project_id = ? ORDER BY created_at DESC`,
    [projectId]
  );
  return NextResponse.json(objectives);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  try {
    const body = await request.json();
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim();
    const phase = ['mvp', 'growth', 'stabilizing'].includes(body.phase) ? body.phase : 'mvp';

    if (!title) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    const project = queryOne<{ id: string; workspace_id: string; name: string }>(
      'SELECT id, workspace_id, name FROM projects WHERE id = ?',
      [projectId]
    );

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const planner = queryOne<{ id: string; session_key_prefix?: string | null }>(
      `SELECT id, session_key_prefix FROM agents WHERE workspace_id = ? AND role = 'planner' ORDER BY created_at ASC LIMIT 1`,
      [project.workspace_id]
    );

    const objectiveId = crypto.randomUUID();
    const plannerPrefix = (planner?.session_key_prefix || DEFAULT_SESSION_KEY_PREFIX) + 'objective:';
    const sessionKey = `${plannerPrefix}${objectiveId}`;

    run(
      `INSERT INTO objectives (id, workspace_id, project_id, title, description, phase, status, planner_session_key, planner_messages, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?, datetime('now'), datetime('now'))`,
      [objectiveId, project.workspace_id, projectId, title, description || null, phase, sessionKey, JSON.stringify([])]
    );

    const prompt = `You are Master Planner for project ${project.name}.
Objective title: ${title}
Objective description: ${description || 'N/A'}
Phase: ${phase}

Return ONLY valid JSON with this schema:
{
  "objective_summary": "...",
  "viability_opinion": "...",
  "viability_score": 0,
  "assumptions": ["..."],
  "risks": ["..."],
  "questions_for_user": ["..."],
  "task_drafts": [
    {
      "title": "Tiny task title",
      "summary": "Small and executable",
      "target_surfaces": ["web"],
      "acceptance_criteria": ["..."],
      "priority": "high"
    }
  ]
}

Rules:
- Tiny granularity only (half-day-ish each)
- Project-only scope
- Include contract/integration tasks when multiple surfaces are needed
- Do not create deadlines`;

    const client = getOpenClawClient();
    if (!client.isConnected()) await client.connect();

    await client.call('chat.send', {
      sessionKey,
      message: prompt,
      idempotencyKey: `objective-start-${objectiveId}-${Date.now()}`,
    });

    return NextResponse.json({
      id: objectiveId,
      project_id: projectId,
      workspace_id: project.workspace_id,
      session_key: sessionKey,
      status: 'planning',
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create objective: ' + (error as Error).message }, { status: 500 });
  }
}
