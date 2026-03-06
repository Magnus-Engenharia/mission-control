import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import type { Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface MapAgentRequest {
  gateway_agent_id: string;
  hydrate_from_openclaw?: boolean;
}

// POST /api/agents/[id]/map - Map a board agent to an OpenClaw agent and hydrate identity files
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = (await request.json()) as MapAgentRequest;

    if (!body.gateway_agent_id || typeof body.gateway_agent_id !== 'string') {
      return NextResponse.json({ error: 'gateway_agent_id is required' }, { status: 400 });
    }

    const existing = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const sessionPrefix = existing.session_key_prefix || `agent:${body.gateway_agent_id}:`;

    run(
      `UPDATE agents
       SET gateway_agent_id = ?,
           source = 'gateway',
           mapping_status = 'mapped',
           mapping_error = NULL,
           status = CASE WHEN status = 'offline' THEN 'standby' ELSE status END,
           session_key_prefix = ?,
           updated_at = ?
       WHERE id = ?`,
      [body.gateway_agent_id, sessionPrefix, now, id]
    );

    // Optionally trigger hydration path in PATCH route semantics by applying file sync here too.
    // We re-use the same behavior by setting a flag marker via direct update contract in this endpoint.
    // Hydration is handled in /api/agents/[id] PATCH; calling code can invoke that explicitly if needed.
    // To keep this endpoint single-call for UI, perform best-effort local file hydration inline.
    if (body.hydrate_from_openclaw !== false) {
      const fs = await import('fs');
      const path = await import('path');
      const home = process.env.HOME || '';
      const baseDir = path.join(home, '.openclaw', 'agents', body.gateway_agent_id);

      if (fs.existsSync(baseDir)) {
        const readIfExists = (p: string): string | null => {
          try {
            if (!fs.existsSync(p)) return null;
            return fs.readFileSync(p, 'utf8');
          } catch {
            return null;
          }
        };

        const soul = readIfExists(path.join(baseDir, 'SOUL.md'));
        const user = readIfExists(path.join(baseDir, 'USER.md'));
        let agentsMd = readIfExists(path.join(baseDir, 'AGENTS.md'));

        const skillsDir = path.join(baseDir, 'skills');
        if (fs.existsSync(skillsDir)) {
          const skills = fs
            .readdirSync(skillsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
            .map((d) => d.name)
            .sort();
          if (skills.length > 0) {
            const skillsSection = `\n\n## Synced Skills\n${skills.map((s) => `- ${s}`).join('\n')}`;
            agentsMd = (agentsMd || '# Team Roster') + skillsSection;
          }
        }

        run(
          `UPDATE agents
           SET soul_md = COALESCE(?, soul_md),
               user_md = COALESCE(?, user_md),
               agents_md = COALESCE(?, agents_md),
               updated_at = ?
           WHERE id = ?`,
          [soul, user, agentsMd, new Date().toISOString(), id]
        );
      }
    }

    const mapped = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    return NextResponse.json(mapped);
  } catch (error) {
    console.error('Failed to map agent:', error);
    return NextResponse.json({ error: 'Failed to map agent' }, { status: 500 });
  }
}
