import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import type { Idea } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams { params: Promise<{ id: string }> }

// POST /api/ideas/[id]/sophie-response
// Publishes Sophie evaluation comment, optionally patches idea fields,
// and clears "reviewing" indicator by setting final status.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json() as {
      comment: string;
      status?: 'new' | 'accepted' | 'rejected';
      title?: string;
      summary?: string;
      score?: number | null;
      tags?: string[];
    };

    const idea = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
    if (!idea) return NextResponse.json({ error: 'Idea not found' }, { status: 404 });

    const comment = (body.comment || '').trim();
    if (!comment) return NextResponse.json({ error: 'comment is required' }, { status: 400 });

    const now = new Date().toISOString();

    run(
      'INSERT INTO idea_comments (id, idea_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [crypto.randomUUID(), id, 'Sophie', comment, now]
    );

    run(
      `UPDATE ideas
       SET title = COALESCE(?, title),
           summary = COALESCE(?, summary),
           score = COALESCE(?, score),
           tags_json = COALESCE(?, tags_json),
           status = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        body.title ?? null,
        body.summary ?? null,
        body.score ?? null,
        body.tags ? JSON.stringify(body.tags) : null,
        body.status || 'new',
        now,
        id,
      ]
    );

    run(
      `INSERT INTO events (id, type, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        'idea_review_completed',
        null,
        `Sophie concluiu revisão da ideia: ${idea.title}`,
        JSON.stringify({ idea_id: id, final_status: body.status || 'new' }),
        now,
      ]
    );

    const updated = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to post Sophie response:', error);
    return NextResponse.json({ error: 'Failed to post Sophie response' }, { status: 500 });
  }
}
