import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const message = String(body.message || '').trim();
    if (!message) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

    const objective = queryOne<{ planner_session_key?: string | null; planner_messages?: string | null }>(
      'SELECT planner_session_key, planner_messages FROM objectives WHERE id = ?',
      [id]
    );
    if (!objective?.planner_session_key) {
      return NextResponse.json({ error: 'Objective planning session not found' }, { status: 404 });
    }

    const client = getOpenClawClient();
    if (!client.isConnected()) await client.connect();

    await client.call('chat.send', {
      sessionKey: objective.planner_session_key,
      message: `User feedback on objective decomposition: ${message}\n\nRespond again with strict JSON using the same schema and updated tiny task drafts.`,
      idempotencyKey: `objective-msg-${id}-${Date.now()}`,
    });

    const msgs = objective.planner_messages ? JSON.parse(objective.planner_messages) : [];
    msgs.push({ role: 'user', content: message, timestamp: Date.now() });
    run('UPDATE objectives SET planner_messages = ?, status = \'planning\', updated_at = datetime(\'now\') WHERE id = ?', [JSON.stringify(msgs), id]);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to send objective message: ' + (error as Error).message }, { status: 500 });
  }
}
