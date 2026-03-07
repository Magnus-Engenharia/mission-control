import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import type { Idea } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteParams { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const idea = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
  if (!idea) return NextResponse.json({ error: 'Idea not found' }, { status: 404 });
  return NextResponse.json(idea);
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json() as Partial<Idea>;
    const existing = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
    if (!existing) return NextResponse.json({ error: 'Idea not found' }, { status: 404 });

    run(
      `UPDATE ideas SET
        title = COALESCE(?, title),
        summary = COALESCE(?, summary),
        source = COALESCE(?, source),
        tags_json = COALESCE(?, tags_json),
        status = COALESCE(?, status),
        score = COALESCE(?, score),
        updated_at = ?
      WHERE id = ?`,
      [
        body.title ?? null,
        body.summary ?? null,
        body.source ?? null,
        body.tags_json ?? null,
        body.status ?? null,
        body.score ?? null,
        new Date().toISOString(),
        id,
      ]
    );

    return NextResponse.json(queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]));
  } catch (error) {
    console.error('Failed to update idea:', error);
    return NextResponse.json({ error: 'Failed to update idea' }, { status: 500 });
  }
}
