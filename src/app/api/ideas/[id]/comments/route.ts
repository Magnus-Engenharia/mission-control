import { NextRequest, NextResponse } from 'next/server';
import { queryAll, run } from '@/lib/db';
import type { IdeaComment } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const comments = queryAll<IdeaComment>('SELECT * FROM idea_comments WHERE idea_id = ? ORDER BY created_at ASC', [id]);
  return NextResponse.json(comments);
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json() as { author?: string; content?: string };
    const content = (body.content || '').trim();
    if (!content) return NextResponse.json({ error: 'content is required' }, { status: 400 });

    const commentId = crypto.randomUUID();
    const now = new Date().toISOString();
    run(
      'INSERT INTO idea_comments (id, idea_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [commentId, id, body.author || 'you', content, now]
    );

    run('UPDATE ideas SET updated_at = ? WHERE id = ?', [now, id]);

    const comments = queryAll<IdeaComment>('SELECT * FROM idea_comments WHERE idea_id = ? ORDER BY created_at ASC', [id]);
    return NextResponse.json(comments, { status: 201 });
  } catch (error) {
    console.error('Failed to create comment:', error);
    return NextResponse.json({ error: 'Failed to create comment' }, { status: 500 });
  }
}
