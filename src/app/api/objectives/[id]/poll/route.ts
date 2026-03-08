import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { extractJSON, getMessagesFromOpenClaw } from '@/lib/planning-utils';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const objective = queryOne<{ id: string; planner_session_key?: string | null; planner_messages?: string | null; status: string }>(
    'SELECT id, planner_session_key, planner_messages, status FROM objectives WHERE id = ?',
    [id]
  );

  if (!objective) return NextResponse.json({ error: 'Objective not found' }, { status: 404 });
  if (!objective.planner_session_key) return NextResponse.json({ error: 'No planner session' }, { status: 400 });

  const existingMessages = objective.planner_messages ? JSON.parse(objective.planner_messages) : [];
  const initialAssistantCount = existingMessages.filter((m: any) => m.role === 'assistant').length;

  const openclawMessages = await getMessagesFromOpenClaw(objective.planner_session_key);
  if (openclawMessages.length <= initialAssistantCount) {
    return NextResponse.json({ hasUpdates: false, status: objective.status });
  }

  let parsedDraft: any = null;
  const newMessages = openclawMessages.slice(initialAssistantCount);
  for (const msg of newMessages) {
    existingMessages.push({ role: 'assistant', content: msg.content, timestamp: Date.now() });
    const parsed = extractJSON(msg.content) as any;
    if (parsed?.task_drafts && Array.isArray(parsed.task_drafts)) {
      parsedDraft = parsed;
    }
  }

  run('UPDATE objectives SET planner_messages = ?, updated_at = datetime(\'now\') WHERE id = ?', [JSON.stringify(existingMessages), id]);

  if (parsedDraft) {
    run(
      `UPDATE objectives SET planner_opinion = ?, viability_score = ?, draft_tasks_json = ?, status = 'ready', updated_at = datetime('now') WHERE id = ?`,
      [
        parsedDraft.viability_opinion || null,
        Number.isFinite(parsedDraft.viability_score) ? parsedDraft.viability_score : null,
        JSON.stringify(parsedDraft.task_drafts || []),
        id,
      ]
    );

    return NextResponse.json({
      hasUpdates: true,
      status: 'ready',
      objective_summary: parsedDraft.objective_summary,
      viability_opinion: parsedDraft.viability_opinion,
      viability_score: parsedDraft.viability_score,
      assumptions: parsedDraft.assumptions || [],
      risks: parsedDraft.risks || [],
      questions_for_user: parsedDraft.questions_for_user || [],
      task_drafts: parsedDraft.task_drafts || [],
    });
  }

  return NextResponse.json({ hasUpdates: true, status: objective.status, messages: existingMessages });
}
