import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { queryOne, run } from '@/lib/db';
import type { Idea } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams { params: Promise<{ id: string }> }

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const idea = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
    if (!idea) return NextResponse.json({ error: 'Idea not found' }, { status: 404 });

    const now = new Date().toISOString();

    run(
      `INSERT INTO events (id, type, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        'idea_review_requested',
        null,
        `Revisão solicitada para ideia: ${idea.title}`,
        JSON.stringify({ idea_id: idea.id, workspace_id: idea.workspace_id, title: idea.title }),
        now,
      ]
    );

    const text = `Mission Control: revisão manual solicitada da ideia "${idea.title}" (id: ${idea.id}). Analise e sugira ajustes.`;
    execFile('openclaw', ['system', 'event', '--text', text, '--mode', 'now'], (err) => {
      if (err) console.warn('[ideas] failed to emit review request event:', err.message);
    });

    return NextResponse.json({ ok: true, idea_id: idea.id, requested_at: now });
  } catch (error) {
    console.error('Failed to request idea review:', error);
    return NextResponse.json({ error: 'Failed to request idea review' }, { status: 500 });
  }
}
