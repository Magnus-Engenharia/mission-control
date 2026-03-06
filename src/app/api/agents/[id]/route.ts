import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import type { Agent, UpdateAgentRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

function tryRead(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function hydrateFromLocalOpenClawAgent(gatewayAgentId: string) {
  const home = process.env.HOME || '';
  const baseDir = path.join(home, '.openclaw', 'agents', gatewayAgentId);

  if (!fs.existsSync(baseDir)) {
    return { found: false as const, soul_md: null, user_md: null, agents_md: null };
  }

  const soul_md = tryRead(path.join(baseDir, 'SOUL.md'));
  const user_md = tryRead(path.join(baseDir, 'USER.md'));
  const agents_mdRaw = tryRead(path.join(baseDir, 'AGENTS.md'));

  let agents_md = agents_mdRaw;
  const skillsDir = path.join(baseDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    const skills = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
      .map((d) => d.name)
      .sort();

    if (skills.length > 0) {
      const skillsSection = `\n\n## Synced Skills\n${skills.map((s) => `- ${s}`).join('\n')}`;
      agents_md = (agents_md || '# Team Roster') + skillsSection;
    }
  }

  return { found: true as const, soul_md, user_md, agents_md };
}

// GET /api/agents/[id] - Get a single agent
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json(agent);
  } catch (error) {
    console.error('Failed to fetch agent:', error);
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 });
  }
}

// PATCH /api/agents/[id] - Update an agent
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body: UpdateAgentRequest = await request.json();

    const existing = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.role !== undefined) {
      updates.push('role = ?');
      values.push(body.role);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description);
    }
    if (body.avatar_emoji !== undefined) {
      updates.push('avatar_emoji = ?');
      values.push(body.avatar_emoji);
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      values.push(body.status);

      // Log status change event
      const now = new Date().toISOString();
      run(
        `INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', id, `${existing.name} is now ${body.status}`, now]
      );
    }
    if (body.is_master !== undefined) {
      updates.push('is_master = ?');
      values.push(body.is_master ? 1 : 0);
    }
    if (body.soul_md !== undefined) {
      updates.push('soul_md = ?');
      values.push(body.soul_md);
    }
    if (body.user_md !== undefined) {
      updates.push('user_md = ?');
      values.push(body.user_md);
    }
    if (body.agents_md !== undefined) {
      updates.push('agents_md = ?');
      values.push(body.agents_md);
    }
    if (body.model !== undefined) {
      updates.push('model = ?');
      values.push(body.model);
    }
    if (body.source !== undefined) {
      updates.push('source = ?');
      values.push(body.source);
    }
    if (body.gateway_agent_id !== undefined) {
      updates.push('gateway_agent_id = ?');
      values.push(body.gateway_agent_id);
    }
    if (body.mapping_status !== undefined) {
      updates.push('mapping_status = ?');
      values.push(body.mapping_status);
    }
    if (body.mapping_error !== undefined) {
      updates.push('mapping_error = ?');
      values.push(body.mapping_error);
    }
    if (body.provisional_from_task_id !== undefined) {
      updates.push('provisional_from_task_id = ?');
      values.push(body.provisional_from_task_id);
    }

    const shouldHydrate = body.hydrate_from_openclaw !== false && !!body.gateway_agent_id;
    if (shouldHydrate && body.gateway_agent_id) {
      const hydrated = hydrateFromLocalOpenClawAgent(body.gateway_agent_id);
      if (hydrated.found) {
        if (hydrated.soul_md) {
          updates.push('soul_md = ?');
          values.push(hydrated.soul_md);
        }
        if (hydrated.user_md) {
          updates.push('user_md = ?');
          values.push(hydrated.user_md);
        }
        if (hydrated.agents_md) {
          updates.push('agents_md = ?');
          values.push(hydrated.agents_md);
        }
      }
    }

    if (body.gateway_agent_id && body.mapping_status === undefined) {
      updates.push('mapping_status = ?');
      values.push('mapped');
      updates.push('mapping_error = ?');
      values.push(null);
      if (body.source === undefined) {
        updates.push('source = ?');
        values.push('gateway');
      }
      if (existing.session_key_prefix == null) {
        updates.push('session_key_prefix = ?');
        values.push(`agent:${body.gateway_agent_id}:`);
      }
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    run(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`, values);

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    return NextResponse.json(agent);
  } catch (error) {
    console.error('Failed to update agent:', error);
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}

// DELETE /api/agents/[id] - Delete an agent
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);

    if (!existing) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Delete or nullify related records first (foreign key constraints)
    run('DELETE FROM openclaw_sessions WHERE agent_id = ?', [id]);
    run('DELETE FROM events WHERE agent_id = ?', [id]);
    run('DELETE FROM messages WHERE sender_agent_id = ?', [id]);
    run('DELETE FROM conversation_participants WHERE agent_id = ?', [id]);
    run('UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [id]);
    run('UPDATE tasks SET created_by_agent_id = NULL WHERE created_by_agent_id = ?', [id]);
    run('UPDATE task_activities SET agent_id = NULL WHERE agent_id = ?', [id]);

    // Now delete the agent
    run('DELETE FROM agents WHERE id = ?', [id]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete agent:', error);
    return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 });
  }
}
