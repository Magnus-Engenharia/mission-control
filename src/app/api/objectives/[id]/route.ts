import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const objective = queryOne('SELECT * FROM objectives WHERE id = ?', [id]);
  if (!objective) return NextResponse.json({ error: 'Objective not found' }, { status: 404 });
  return NextResponse.json(objective);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const exists = queryOne<{ id: string }>('SELECT id FROM objectives WHERE id = ?', [id]);
  if (!exists) return NextResponse.json({ error: 'Objective not found' }, { status: 404 });

  run('DELETE FROM objectives WHERE id = ?', [id]);
  return NextResponse.json({ success: true });
}
