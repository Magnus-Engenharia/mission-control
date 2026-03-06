import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import type { Agent, CreateAgentRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';
// GET /api/agents - List all agents
export async function GET(request: NextRequest) {
  try {
    const workspaceId = request.nextUrl.searchParams.get('workspace_id');
    
    let agents: Agent[];
    if (workspaceId) {
      agents = queryAll<Agent>(`
        SELECT * FROM agents WHERE workspace_id = ? ORDER BY is_master DESC, name ASC
      `, [workspaceId]);
    } else {
      agents = queryAll<Agent>(`
        SELECT * FROM agents ORDER BY is_master DESC, name ASC
      `);
    }
    return NextResponse.json(agents);
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
}

// POST /api/agents - Create a new agent
export async function POST(request: NextRequest) {
  try {
    const body: CreateAgentRequest = await request.json();

    if (!body.name || !body.role) {
      return NextResponse.json({ error: 'Name and role are required' }, { status: 400 });
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const workspaceId = (body as { workspace_id?: string }).workspace_id || 'default';

    // Guardrails: cap agent count per workspace and prevent duplicate name/role spam
    const MAX_AGENTS_PER_WORKSPACE = 12;
    const countRow = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM agents WHERE workspace_id = ?', [workspaceId]);
    const currentCount = Number(countRow?.count || 0);
    if (currentCount >= MAX_AGENTS_PER_WORKSPACE) {
      return NextResponse.json(
        { error: `Workspace agent limit reached (${MAX_AGENTS_PER_WORKSPACE}). Delete or archive agents before creating more.` },
        { status: 400 }
      );
    }

    const duplicate = queryOne<{ id: string }>(
      `SELECT id FROM agents WHERE workspace_id = ? AND (lower(name) = lower(?) OR lower(role) = lower(?)) LIMIT 1`,
      [workspaceId, body.name, body.role]
    );
    if (duplicate) {
      return NextResponse.json(
        { error: 'Agent with same name or role already exists in this workspace.' },
        { status: 409 }
      );
    }

    run(
      `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, soul_md, user_md, agents_md, model, source, gateway_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name,
        body.role,
        body.description || null,
        body.avatar_emoji || '🤖',
        body.is_master ? 1 : 0,
        workspaceId,
        body.soul_md || null,
        body.user_md || null,
        body.agents_md || null,
        body.model || null,
        body.source || (body.gateway_agent_id ? 'gateway' : 'local'),
        body.gateway_agent_id || null,
        now,
        now,
      ]
    );

    // Log event
    run(
      `INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'agent_joined', id, `${body.name} joined the team`, now]
    );

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    return NextResponse.json(agent, { status: 201 });
  } catch (error) {
    console.error('Failed to create agent:', error);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}
